import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FetchLike } from "../auth.ts";
import type { DatabricksClient } from "../client.ts";
import { InvalidArgumentError, messageWithoutUrls } from "../errors.ts";
import type { ExecutionHandle, LogService } from "../logging/service.ts";
import { SqlError, type ExecuteSqlRequest, type ExecutionDiagnostics, type SqlService } from "../sql.ts";
import { createCsvSink } from "./csv-sink.ts";
import { createParquetSink } from "./parquet-sink.ts";
import { exportId, exportPath } from "./paths.ts";
import { createSqliteSink } from "./sqlite-sink.ts";
import type { ChunkSink, ExportFormat, ExportState, ManifestColumn, SinkContext } from "./types.ts";

/** Collaborators of the export manager; `sinks` replaces the sink factories (tests inject fakes). */
export interface ExportManagerDependencies {
  client: DatabricksClient;
  sql: Pick<SqlService, "submitExport">;
  fetch: FetchLike;
  /** Export directory; a relative path is resolved against the working directory at creation. */
  dir: string;
  logs: LogService;
  sleep(ms: number): Promise<void>;
  /** Downloads in flight per export (default 4). */
  concurrency?: number;
  sinks?: Partial<Record<ExportFormat, (context: SinkContext) => Promise<ChunkSink>>>;
}

/** Background exports keyed by statement id. */
export interface ExportManager {
  /**
   * Submits the statement and returns the `PENDING` state; polling and downloading continue in the background.
   * `diagnostics` receives the read-only check duration and the warehouse, as filled by `submitExport`.
   */
  start(request: { statement: ExecuteSqlRequest; format: ExportFormat; name?: string }, diagnostics?: ExecutionDiagnostics): Promise<ExportState>;
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
  /** Cancels every running export, including its Databricks statement. */
  close(): Promise<void>;
}

interface ExternalLink {
  chunk_index?: number;
  row_count?: number;
  external_link: string;
  expiration?: string;
}

interface ExportStatement {
  status: { state: string; error?: { message?: string } };
  manifest?: {
    total_chunk_count?: number;
    total_row_count?: number;
    truncated?: boolean;
    schema?: { columns?: ManifestColumn[] };
    chunks?: Array<{ chunk_index: number; row_count?: number }>;
  };
  result?: { external_links?: ExternalLink[] };
}

interface Job {
  state: ExportState;
  execution: ExecutionHandle;
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

const STATEMENTS_PATH = "/api/2.0/sql/statements";
const DEFAULT_CONCURRENCY = 4;
const MAX_POLL_DELAY_MS = 10_000;
/** Waits before the retries of a download that failed with a network error, 429 or 5xx. */
const DOWNLOAD_RETRY_DELAYS_MS = [500, 1000, 2000];
const PART_MAX_AGE_MS = 24 * 3_600_000;
const FINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const DEFAULT_SINKS: Record<ExportFormat, (context: SinkContext) => Promise<ChunkSink>> = {
  csv: createCsvSink,
  parquet: createParquetSink,
  sqlite: (context) => createSqliteSink(context),
};

/** Settles like `promise`, or rejects as soon as `signal` aborts (the work itself keeps running unobserved). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((settle, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(settle, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

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

  const snapshot = (job: Job): ExportState => structuredClone(job.state);
  const statementPath = (statementId: string) => `${STATEMENTS_PATH}/${encodeURIComponent(statementId)}`;

  async function pollUntilSucceeded(statementId: string, signal: AbortSignal): Promise<ExportStatement> {
    // No upper bound by design: a statement stuck in PENDING or RUNNING is polled every 10 s until Databricks ends it
    // or the job is cancelled.
    for (let attempt = 1; ; attempt++) {
      const statement = await untilAborted(deps.client.get<ExportStatement>(statementPath(statementId)), signal);
      const state = statement.status.state;
      if (state === "SUCCEEDED") return statement;
      if (state !== "PENDING" && state !== "RUNNING") {
        throw new SqlError(statement.status.error?.message ?? `Export statement ended in state ${state}.`);
      }
      await untilAborted(deps.sleep(Math.min(attempt * 1000, MAX_POLL_DELAY_MS)), signal);
    }
  }

  async function requestLink(statementId: string, index: number, signal: AbortSignal): Promise<ExternalLink> {
    const response = await untilAborted(deps.client.get<{ external_links?: ExternalLink[] }>(`${statementPath(statementId)}/result/chunks/${index}`), signal);
    const link = response.external_links?.[0];
    if (link === undefined) throw new Error(`Export: Databricks returned no link for chunk ${index}.`);
    return link;
  }

  /**
   * Downloads one chunk. An expired link or a 403 gets one fresh link; a network error, 429 or 5xx is retried after
   * the waits of `DOWNLOAD_RETRY_DELAYS_MS`; any other status fails at once. Link URLs carry credentials: never log them.
   */
  async function downloadChunk(job: Job, index: number, firstLink: ExternalLink | undefined): Promise<DownloadedChunk> {
    const { signal } = job.controller;
    const { statementId } = job.state;
    let link = firstLink ?? (await requestLink(statementId, index, signal));
    let refreshed = false;
    let retries = 0;
    for (;;) {
      const expired = link.expiration !== undefined && Date.parse(link.expiration) <= Date.now();
      let status: number | undefined;
      let reason = "link expired";
      if (!expired) {
        try {
          const response = await deps.fetch(link.external_link, { signal });
          if (response.ok) return { bytes: new Uint8Array(await response.arrayBuffer()), rowCount: link.row_count ?? 0 };
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
        job.execution.warn("Export chunk link refreshed", { chunk: index, reason });
        link = await requestLink(statementId, index, signal);
        continue;
      }
      const retryable = !expired && (status === undefined || status === 429 || status >= 500);
      const delayMs = DOWNLOAD_RETRY_DELAYS_MS[retries];
      if (!retryable || delayMs === undefined) {
        throw new Error(`Export: chunk ${index} download failed (${reason})${retries > 0 ? ` after ${retries} retries` : ""}.`);
      }
      retries += 1;
      job.execution.warn("Export chunk download retried", { chunk: index, attempt: retries, delayMs, ...(status === undefined ? { error: reason } : { status }) });
      await untilAborted(deps.sleep(delayMs), signal);
    }
  }

  /** Downloads every chunk within the look-ahead window and writes them to `sink` strictly in chunk order. */
  async function transfer(job: Job, statement: ExportStatement, sink: ChunkSink): Promise<void> {
    const { signal } = job.controller;
    const total = statement.manifest?.total_chunk_count ?? 0;
    const inlineLink = statement.result?.external_links?.[0];
    const firstLink = inlineLink !== undefined && (inlineLink.chunk_index ?? 0) === 0 ? inlineLink : undefined;
    const manifestRows = new Map(statement.manifest?.chunks?.map((chunk) => [chunk.chunk_index, chunk.row_count]));
    const downloads = new Map<number, Promise<DownloadedChunk>>();
    let nextToStart = 0;
    let nextToWrite = 0;
    let inFlight = 0;

    function startDownloads(): void {
      while (!signal.aborted && inFlight < concurrency && nextToStart < total && nextToStart < nextToWrite + 2 * concurrency) {
        const index = nextToStart++;
        inFlight += 1;
        const download = downloadChunk(job, index, index === 0 ? firstLink : undefined).finally(() => {
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
        const rowCount = manifestRows.get(nextToWrite) ?? chunk.rowCount;
        await sink.write({ index: nextToWrite, rowCount, bytes: chunk.bytes });
        const progress = job.state.progress as NonNullable<ExportState["progress"]>;
        progress.chunksDone += 1;
        progress.rows += rowCount;
        progress.bytes += chunk.bytes.byteLength;
        job.execution.debug("Export chunk written", { chunk: nextToWrite, rows: rowCount, bytes: chunk.bytes.byteLength });
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

  async function runJob(job: Job): Promise<void> {
    const { signal } = job.controller;
    const { execution } = job;
    const startedAt = Date.now();
    let sink: ChunkSink | undefined;
    let finishing = false;
    execution.info("Export started", { format: job.state.format, statementId: job.state.statementId, path: job.state.path });
    try {
      const statement = await pollUntilSucceeded(job.state.statementId, signal);
      const columns = statement.manifest?.schema?.columns ?? [];
      const chunksTotal = statement.manifest?.total_chunk_count ?? 0;
      sink = await sinks[job.state.format]({ id: job.state.id, dir, columns });
      job.state.status = "DOWNLOADING";
      job.state.progress = { chunksDone: 0, chunksTotal, rows: 0, bytes: 0 };
      await transfer(job, statement, sink);
      if (signal.aborted) throw signal.reason;
      // From here on a cancel no longer counts: the job ends SUCCEEDED, or FAILED with the error of finish().
      finishing = true;
      const { files } = await sink.finish();
      const { rows, bytes } = job.state.progress;
      const truncated = statement.manifest?.truncated === true;
      Object.assign(job.state, { status: "SUCCEEDED", files, rows, bytes, truncated });
      execution.info("Export finished", { rows, chunks: chunksTotal, bytes, durationMs: Date.now() - startedAt, truncated });
      execution.complete();
    } catch (error) {
      abortJob(job, error);
      // The abort reason is the first failure, which may come from a download other than the one that surfaced here.
      const failure: unknown = finishing ? error : signal.reason;
      await sink?.abort().catch((abortError: unknown) => execution.warn(`Export partial files not removed: ${messageWithoutUrls((abortError as Error).message)}`));
      if (job.canceled && !finishing) {
        job.state.status = "CANCELED";
        execution.cancel();
      } else {
        Object.assign(job.state, { status: "FAILED", error: messageWithoutUrls(failure instanceof Error ? failure.message : String(failure)) });
        execution.fail(failure);
      }
    }
  }

  async function start(request: { statement: ExecuteSqlRequest; format: ExportFormat; name?: string }, diagnostics?: ExecutionDiagnostics): Promise<ExportState> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { statementId } = await deps.sql.submitExport(request.statement, request.format, diagnostics);
    const id = exportId(request.name, statementId);
    const path = exportPath(dir, id, request.format);
    const running = [...jobs.values()].some((job) => job.state.path === path && !FINAL_STATUSES.has(job.state.status));
    const pathExists = await access(path).then(
      () => true,
      () => false,
    );
    if (running || pathExists) {
      await deps.client.post(`${statementPath(statementId)}/cancel`).catch(() => undefined);
      throw new InvalidArgumentError(`Export ${path} already exists; choose another name.`);
    }
    const execution = deps.logs.startExecution({ toolName: "export" });
    const job: Job = {
      state: { id, statementId, format: request.format, path, status: "PENDING" },
      execution,
      controller: new AbortController(),
      canceled: false,
      done: Promise.resolve(),
    };
    // runJob handles its own failures; this only catches a bug in it, so the job never stays running forever.
    job.done = deps.logs.run(execution, () => runJob(job)).catch((error: unknown) => {
      if (!FINAL_STATUSES.has(job.state.status)) Object.assign(job.state, { status: "FAILED", error: messageWithoutUrls(error instanceof Error ? error.message : String(error)) });
      execution.fail(error);
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
      deps.client.post(`${statementPath(statementId)}/cancel`).catch(() => undefined);
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
      await Promise.all([...jobs.keys()].map(cancel));
    },
  };
}
