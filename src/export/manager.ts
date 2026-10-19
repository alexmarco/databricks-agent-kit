import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { untilAborted } from "../abort.ts";
import type { FetchLike } from "../auth.ts";
import { DakError, InvalidArgumentError, messageWithoutUrls } from "../errors.ts";
import { ExecutionCancelled, type ExecutionScope } from "../execution-scope.ts";
import type { ExecutionHandle } from "../logging/service.ts";
import type { ExecuteSqlRequest, ExportChunkLink, ExportResultInfo, StatementLifecycle } from "../statements.ts";
import { createCsvSink } from "./csv-sink.ts";
import { createParquetSink } from "./parquet-sink.ts";
import { exportId, exportPath } from "./paths.ts";
import { createSqliteSink } from "./sqlite-sink.ts";
import type { ChunkSink, ExportFormat, ExportState, SinkContext } from "./types.ts";

/** Collaborators of the export manager; `sinks` replaces the sink factories (tests inject fakes). */
export interface ExportManagerDependencies {
  /** The statement lifecycle seam: the manager makes no statement request of its own. */
  statements: Pick<StatementLifecycle, "submitExport" | "awaitExport" | "exportChunkLink" | "cancel">;
  fetch: FetchLike;
  /** Export directory; a relative path is resolved against the working directory at creation. */
  dir: string;
  /** Opens the log execution of each export job (ADR 0013). */
  scope: Pick<ExecutionScope, "run">;
  sleep(ms: number): Promise<void>;
  /** Downloads in flight per export (default 4). */
  concurrency?: number;
  sinks?: Partial<Record<ExportFormat, (context: SinkContext) => Promise<ChunkSink>>>;
}

/** Background exports keyed by statement id. */
export interface ExportManager {
  /** Submits the statement and returns the `PENDING` state; polling and downloading continue in the background. */
  start(request: { statement: ExecuteSqlRequest; format: ExportFormat; name?: string }): Promise<ExportState>;
  get(statementId: string): Promise<ExportState | undefined>;
  /** Waits up to `timeoutMs` for the export to end and returns its state at that moment. */
  wait(statementId: string, timeoutMs: number): Promise<ExportState | undefined>;
  /**
   * Stops a running export, deletes its partial files and sends a best-effort cancel of its Databricks statement; false
   * for an unknown or already finished export.
   */
  cancel(statementId: string): Promise<boolean>;
  /** Deletes `.part` entries of `dir` modified more than 24 hours before `now`. */
  cleanup(now?: number): Promise<void>;
  /** Cancels every running export, including its Databricks statement, and refuses to start new ones (ADR 0015). */
  close(): Promise<void>;
}

interface Job {
  state: ExportState;
  /** Aborted by `cancel` or by the first failure, whose error is then the abort reason. */
  controller: AbortController;
  /** Set by `cancel` when it was the first to abort, so a failure is never reported as a cancellation. */
  canceled: boolean;
  /** Settles when the job reached a final state; never rejects. */
  done: Promise<void>;
}

interface DownloadedChunk {
  bytes: Uint8Array;
  rowCount: number;
}

const DEFAULT_CONCURRENCY = 4;
/** Waits before the retries of a download that failed with a network error, 429 or 5xx. */
const DOWNLOAD_RETRY_DELAYS_MS = [500, 1000, 2000];
const PART_MAX_AGE_MS = 24 * 3_600_000;
const FINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const DEFAULT_SINKS: Record<ExportFormat, (context: SinkContext) => Promise<ChunkSink>> = {
  csv: createCsvSink,
  parquet: createParquetSink,
  sqlite: (context) => createSqliteSink(context),
};

/**
 * Deletes `.part` entries of `dir` modified more than 24 hours before `now`; a missing directory is ignored. It needs
 * no credentials, so the server can run it at startup.
 */
export async function cleanupOrphanedParts(dir: string, now = Date.now()): Promise<void> {
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names.filter((entry) => entry.endsWith(".part"))) {
    const path = join(dir, name);
    try {
      // lstat and rm act on a symbolic link itself, never on its target.
      const stats = await lstat(path);
      if (now - stats.mtimeMs > PART_MAX_AGE_MS) await rm(path, { recursive: true, force: true });
    } catch (error) {
      // An entry removed meanwhile (by another process) needs no cleanup.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Creates the export manager. Each export runs as a background job in its own log execution: it polls the statement
 * until it succeeds, downloads the chunks through presigned links (plain GET, no `Authorization`) with at most
 * `concurrency` downloads in flight and a bounded look-ahead, and writes them to the format's sink in chunk order.
 */
export function createExportManager(deps: ExportManagerDependencies): ExportManager {
  const dir = resolve(deps.dir);
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const sinks = { ...DEFAULT_SINKS, ...deps.sinks };
  const jobs = new Map<string, Job>();
  let closed = false;
  const shuttingDown = () => new DakError("SHUTTING_DOWN", "The server is shutting down; the export was not started.");

  const snapshot = (job: Job): ExportState => structuredClone(job.state);

  /**
   * Downloads one chunk. An expired link or a 403 gets one fresh link; a network error, 429 or 5xx is retried after
   * the waits of `DOWNLOAD_RETRY_DELAYS_MS`; any other status fails at once. Link URLs carry credentials: never log them.
   */
  async function downloadChunk(job: Job, execution: ExecutionHandle, index: number, firstLink: ExportChunkLink | undefined): Promise<DownloadedChunk> {
    const { signal } = job.controller;
    const { statementId } = job.state;
    let link = firstLink ?? (await deps.statements.exportChunkLink(statementId, index, signal));
    let refreshed = false;
    let retries = 0;
    for (;;) {
      const expired = link.expiration !== undefined && Date.parse(link.expiration) <= Date.now();
      let status: number | undefined;
      let reason = "link expired";
      if (!expired) {
        try {
          const response = await deps.fetch(link.url, { signal });
          if (response.ok) return { bytes: new Uint8Array(await response.arrayBuffer()), rowCount: link.rowCount ?? 0 };
          await response.body?.cancel();
          status = response.status;
          reason = `HTTP ${status}`;
        } catch (error) {
          if (signal.aborted) throw error;
          reason = messageWithoutUrls(error instanceof Error ? error.message : String(error));
        }
      }
      if ((expired || status === 403) && !refreshed) {
        refreshed = true;
        execution.warn("Export chunk link refreshed", { chunk: index, reason });
        link = await deps.statements.exportChunkLink(statementId, index, signal);
        continue;
      }
      const retryable = !expired && (status === undefined || status === 429 || status >= 500);
      const delayMs = DOWNLOAD_RETRY_DELAYS_MS[retries];
      if (!retryable || delayMs === undefined) {
        throw new Error(`Export: chunk ${index} download failed (${reason})${retries > 0 ? ` after ${retries} retries` : ""}.`);
      }
      retries += 1;
      execution.warn("Export chunk download retried", { chunk: index, attempt: retries, delayMs, ...(status === undefined ? { error: reason } : { status }) });
      await untilAborted(deps.sleep(delayMs), signal);
    }
  }

  /** Downloads every chunk within the look-ahead window and writes them to `sink` strictly in chunk order. */
  async function transfer(job: Job, execution: ExecutionHandle, result: ExportResultInfo, sink: ChunkSink): Promise<void> {
    const { signal } = job.controller;
    const total = result.chunkCount;
    const downloads = new Map<number, Promise<DownloadedChunk>>();
    let nextToStart = 0;
    let nextToWrite = 0;
    let inFlight = 0;

    function startDownloads(): void {
      while (!signal.aborted && inFlight < concurrency && nextToStart < total && nextToStart < nextToWrite + 2 * concurrency) {
        const index = nextToStart++;
        inFlight += 1;
        const download = downloadChunk(job, execution, index, index === 0 ? result.firstLink : undefined).finally(() => {
          inFlight -= 1;
          startDownloads();
        });
        // Fail fast: the first failed download aborts the job at once, without waiting for its turn in write order.
        download.catch((error: unknown) => abortJob(job, error));
        downloads.set(index, download);
      }
    }

    try {
      startDownloads();
      for (; nextToWrite < total; nextToWrite++) {
        const chunk = await (downloads.get(nextToWrite) as Promise<DownloadedChunk>);
        downloads.delete(nextToWrite);
        if (signal.aborted) throw signal.reason;
        const rowCount = result.chunkRowCounts.get(nextToWrite) ?? chunk.rowCount;
        await sink.write({ index: nextToWrite, rowCount, bytes: chunk.bytes });
        const progress = job.state.progress as NonNullable<ExportState["progress"]>;
        progress.chunksDone += 1;
        progress.rows += rowCount;
        progress.bytes += chunk.bytes.byteLength;
        execution.debug("Export chunk written", { chunk: nextToWrite, rows: rowCount, bytes: chunk.bytes.byteLength });
        startDownloads();
      }
    } catch (error) {
      abortJob(job, error);
      await Promise.allSettled(downloads.values());
      throw error;
    }
  }

  /** Aborts the job with `reason` as its failure, unless a cancel or an earlier failure already aborted it. */
  function abortJob(job: Job, reason: unknown): void {
    if (!job.controller.signal.aborted) job.controller.abort(reason);
  }

  /**
   * Runs the job in its log execution: it returns on success, throws {@link ExecutionCancelled} when the job was
   * cancelled and the failure otherwise, so the scope ends the execution as completed, cancelled or failed.
   */
  async function runJob(job: Job, execution: ExecutionHandle): Promise<void> {
    const { signal } = job.controller;
    const startedAt = Date.now();
    let sink: ChunkSink | undefined;
    let finishing = false;
    execution.info("Export started", { format: job.state.format, statementId: job.state.statementId, path: job.state.path });
    try {
      const result = await deps.statements.awaitExport(job.state.statementId, signal);
      const chunksTotal = result.chunkCount;
      sink = await sinks[job.state.format]({ id: job.state.id, dir, columns: result.columns });
      job.state.status = "DOWNLOADING";
      job.state.progress = { chunksDone: 0, chunksTotal, rows: 0, bytes: 0 };
      await transfer(job, execution, result, sink);
      if (signal.aborted) throw signal.reason;
      // From here on a cancel no longer counts: the job ends SUCCEEDED, or FAILED with the error of finish().
      finishing = true;
      const { files } = await sink.finish();
      const { rows, bytes } = job.state.progress;
      const { truncated } = result;
      Object.assign(job.state, { status: "SUCCEEDED", files, rows, bytes, truncated });
      execution.info("Export finished", { rows, chunks: chunksTotal, bytes, durationMs: Date.now() - startedAt, truncated });
    } catch (error) {
      abortJob(job, error);
      // The abort reason is the first failure, which may come from a download other than the one that surfaced here.
      const failure: unknown = finishing ? error : signal.reason;
      await sink?.abort().catch((abortError: unknown) => execution.warn(`Export partial files not removed: ${messageWithoutUrls((abortError as Error).message)}`));
      if (job.canceled && !finishing) {
        job.state.status = "CANCELED";
        throw new ExecutionCancelled();
      }
      Object.assign(job.state, { status: "FAILED", error: messageWithoutUrls(failure instanceof Error ? failure.message : String(failure)) });
      throw failure;
    }
  }

  async function start(request: { statement: ExecuteSqlRequest; format: ExportFormat; name?: string }): Promise<ExportState> {
    if (closed) throw shuttingDown();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { statementId } = await deps.statements.submitExport(request.statement, request.format);
    if (closed) {
      await deps.statements.cancel(statementId).catch(() => undefined);
      throw shuttingDown();
    }
    const id = exportId(request.name, statementId);
    const path = exportPath(dir, id, request.format);
    const running = [...jobs.values()].some((job) => job.state.path === path && !FINAL_STATUSES.has(job.state.status));
    const pathExists = await access(path).then(
      () => true,
      () => false,
    );
    if (running || pathExists) {
      await deps.statements.cancel(statementId).catch(() => undefined);
      throw new InvalidArgumentError(`Export ${path} already exists; choose another name.`);
    }
    const job: Job = {
      state: { id, statementId, format: request.format, path, status: "PENDING" },
      controller: new AbortController(),
      canceled: false,
      done: Promise.resolve(),
    };
    // runJob sets the final state of its own failures and cancellation, which the scope already logged; this only
    // catches a bug in it, so the job never stays running forever.
    job.done = deps.scope.run({ toolName: "export" }, (execution) => runJob(job, execution)).catch((error: unknown) => {
      if (!FINAL_STATUSES.has(job.state.status)) Object.assign(job.state, { status: "FAILED", error: messageWithoutUrls(error instanceof Error ? error.message : String(error)) });
    });
    jobs.set(statementId, job);
    return snapshot(job);
  }

  async function wait(statementId: string, timeoutMs: number): Promise<ExportState | undefined> {
    const job = jobs.get(statementId);
    if (job === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((settle) => {
      timer = setTimeout(settle, timeoutMs);
    });
    await Promise.race([job.done, timeout]);
    clearTimeout(timer);
    return snapshot(job);
  }

  async function cancel(statementId: string): Promise<boolean> {
    const job = jobs.get(statementId);
    if (job === undefined || FINAL_STATUSES.has(job.state.status)) return false;
    // A job already aborted by a failure stays FAILED: the cancel only waits for its cleanup.
    if (!job.controller.signal.aborted) {
      job.canceled = true;
      job.controller.abort();
      // Best effort, so the warehouse stops computing too; the cancel never waits for it or fails because of it.
      deps.statements.cancel(statementId).catch(() => undefined);
    }
    await job.done;
    return job.state.status === "CANCELED";
  }

  return {
    start,
    get: async (statementId) => {
      const job = jobs.get(statementId);
      return job === undefined ? undefined : snapshot(job);
    },
    wait,
    cancel,
    cleanup: (now) => cleanupOrphanedParts(dir, now),
    close: async () => {
      closed = true;
      await Promise.all([...jobs.keys()].map(cancel));
    },
  };
}
