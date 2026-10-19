import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fsPromises, { access, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DakError, InvalidArgumentError } from "../src/errors.ts";
import { createExecutionScope } from "../src/execution-scope.ts";
import { cleanupOrphanedParts, createExportManager, type ExportManagerDependencies } from "../src/export/manager.ts";
import type { ChunkSink, ExportFormat, ExportState, SinkContext } from "../src/export/types.ts";
import type { LogService } from "../src/logging/service.ts";
import { SqlError, type ExportChunkLink, type ExportResultInfo } from "../src/statements.ts";
import { withLogs } from "./helpers.ts";

const STATEMENT_ID = "01ef-statement";
const HOUR_MS = 3_600_000;

interface StatementOptions {
  chunks: number;
  rowsPerChunk?: number;
  truncated?: boolean;
  /** Final state of the export statement (default SUCCEEDED); any other state makes `awaitExport` fail. */
  state?: string;
  errorMessage?: string;
  /** Link of chunk 0 that comes with the finished statement (default none). */
  firstLink?: ExportChunkLink;
  /** The statement never finishes: `awaitExport` only settles when its signal aborts. */
  pending?: boolean;
  /** Statement ids handed out by `submitExport`, in order (default `STATEMENT_ID`). */
  ids?: string[];
  /** The Databricks cancel request fails. */
  cancelFails?: boolean;
}

/** Fake statement lifecycle seam for exports: chunk links count their requests, cancels are recorded. */
function fakeStatements(options: StatementOptions) {
  const linkRequests = new Map<number, number>();
  const cancels: string[] = [];
  const awaited: string[] = [];
  const ids = [...(options.ids ?? [])];
  const rowsPerChunk = options.rowsPerChunk ?? 10;
  const state = options.state ?? "SUCCEEDED";
  const statements: ExportManagerDependencies["statements"] = {
    async submitExport() {
      return { statementId: ids.shift() ?? STATEMENT_ID, warehouseId: "wh1" };
    },
    async awaitExport(statementId, signal) {
      awaited.push(statementId);
      if (options.pending === true) {
        return new Promise<ExportResultInfo>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }
      if (state !== "SUCCEEDED")
        throw new SqlError(options.errorMessage ?? `Export statement ended in state ${state}.`);
      return {
        columns: [{ name: "id", type_name: "INT", type_text: "INT", position: 0 }],
        chunkCount: options.chunks,
        chunkRowCounts: new Map(Array.from({ length: options.chunks }, (_, index) => [index, rowsPerChunk])),
        truncated: options.truncated ?? false,
        firstLink: options.firstLink,
      };
    },
    async exportChunkLink(_statementId, index) {
      const attempt = (linkRequests.get(index) ?? 0) + 1;
      linkRequests.set(index, attempt);
      return { url: `https://storage.example/chunk-${index}?attempt=${attempt}`, rowCount: rowsPerChunk };
    },
    async cancel(statementId) {
      cancels.push(statementId);
      if (options.cancelFails === true) throw new Error("network down");
    },
  };
  return { statements, linkRequests, cancels, awaited };
}

/** Fake sink that records its calls; `onWrite` runs inside `write`. */
function fakeSink(options: { onWrite?: (index: number) => Promise<void> } = {}) {
  const calls: string[] = [];
  const contexts: SinkContext[] = [];
  const factory = async (context: SinkContext): Promise<ChunkSink> => {
    contexts.push(context);
    return {
      async write(chunk) {
        calls.push(`write:${chunk.index}`);
        await options.onWrite?.(chunk.index);
      },
      async finish() {
        calls.push("finish");
        return { files: [join(context.dir, `${context.id}.csv`)] };
      },
      async abort() {
        calls.push("abort");
      },
    };
  };
  return { calls, contexts, factory };
}

type FetchCall = { url: string; init: RequestInit | undefined };

/** Fake download: body `chunk-<n>`, resolved after `delayMs(index)` milliseconds, or thrown `error(url)`. */
function fakeFetch(
  options: {
    delayMs?: (index: number) => number;
    status?: (url: string) => number;
    error?: (url: string) => Error | undefined;
  } = {},
) {
  const calls: FetchCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const index = Number(/chunk-(\d+)/.exec(url)?.[1]);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs?.(index) ?? 0));
      const error = options.error?.(url);
      if (error !== undefined) throw error;
      const status = options.status?.(url) ?? 200;
      return new Response(status === 200 ? `chunk-${index}` : "denied", { status });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, calls, maxInFlight: () => maxInFlight };
}

/** Download that only settles when its signal aborts. */
function hangingFetch() {
  const calls: FetchCall[] = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  return { fetch, calls };
}

function managerDeps(
  logs: LogService,
  dir: string,
  overrides: Partial<ExportManagerDependencies> & Pick<ExportManagerDependencies, "statements" | "fetch">,
): ExportManagerDependencies {
  return {
    dir: join(dir, "exports"),
    scope: createExecutionScope(logs),
    sleep: async () => undefined,
    ...overrides,
  };
}

const exportRequest = (format: ExportFormat = "csv") => ({
  statement: { statement: "SELECT * FROM t" },
  format,
  name: "sales",
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "condition not reached");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test("chunks resolved out of order are written in order with at most 4 downloads in flight and no auth header", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 5 });
    const downloads = fakeFetch({ delayMs: (index) => (5 - index) * 10 });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory } }),
    );

    const initial = await manager.start(exportRequest());
    assert.equal(initial.status, "PENDING");
    assert.equal(initial.statementId, STATEMENT_ID);
    assert.equal(initial.id, "sales-01ef-statement");
    assert.equal(initial.path, join(dir, "exports", "sales-01ef-statement.csv"));

    const final = await manager.wait(STATEMENT_ID, 1000);
    assert.equal(final?.status, "SUCCEEDED");
    assert.deepEqual(sink.calls, ["write:0", "write:1", "write:2", "write:3", "write:4", "finish"]);
    assert.equal(downloads.maxInFlight(), 4);
    assert.equal(downloads.calls.length, 5);
    for (const call of downloads.calls) {
      assert.ok(call.init?.signal instanceof AbortSignal);
      assert.equal(call.init?.headers, undefined);
    }
    assert.equal(sink.contexts[0]?.id, "sales-01ef-statement");
    assert.deepEqual(
      sink.contexts[0]?.columns.map((column) => column.name),
      ["id"],
    );
  });
});

test("get reports DOWNLOADING with growing progress and wait returns the final SUCCEEDED state", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 3, rowsPerChunk: 7 });
    const seen: Array<ExportState | undefined> = [];
    let manager: ReturnType<typeof createExportManager> | undefined;
    const sink = fakeSink({
      onWrite: async () => {
        seen.push(await manager?.get(STATEMENT_ID));
      },
    });
    manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.deepEqual(
      seen.map((state) => [state?.status, state?.progress?.chunksDone, state?.progress?.chunksTotal]),
      [
        ["DOWNLOADING", 0, 3],
        ["DOWNLOADING", 1, 3],
        ["DOWNLOADING", 2, 3],
      ],
    );
    assert.equal(final?.status, "SUCCEEDED");
    assert.equal(final?.rows, 21);
    assert.equal(final?.bytes, "chunk-0".length * 3);
    assert.equal(final?.truncated, false);
    assert.deepEqual(final?.files, [join(dir, "exports", "sales-01ef-statement.csv")]);
    assert.deepEqual(await manager.get(STATEMENT_ID), final);
    assert.equal(await manager.get("unknown"), undefined);
    assert.equal(await manager.wait("unknown", 10), undefined);
  });
});

test("a 403 on the first download requests a new link once and succeeds", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, linkRequests } = fakeStatements({ chunks: 4 });
    const downloads = fakeFetch({ status: (url) => (url.includes("chunk-2?attempt=1") ? 403 : 200) });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "SUCCEEDED");
    assert.equal(linkRequests.get(2), 2);
    assert.equal(linkRequests.get(1), 1);
    assert.deepEqual(sink.calls, ["write:0", "write:1", "write:2", "write:3", "finish"]);
  });
});

test("a second 403 fails the job with an error that names the chunk", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, linkRequests } = fakeStatements({ chunks: 4 });
    const downloads = fakeFetch({ status: (url) => (url.includes("chunk-2") ? 403 : 200) });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.match(final?.error ?? "", /chunk 2/);
    assert.equal(linkRequests.get(2), 2);
    assert.equal(sink.calls.at(-1), "abort");
    assert.ok(!sink.calls.includes("finish"));
  });
});

test("zero chunks still finish the sink and succeed with 0 rows", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 0 });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "SUCCEEDED");
    assert.equal(final?.rows, 0);
    assert.deepEqual(sink.calls, ["finish"]);
  });
});

test("a truncated manifest ends SUCCEEDED with truncated true", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1, truncated: true });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "SUCCEEDED");
    assert.equal(final?.truncated, true);
  });
});

test("cancel aborts a running download, aborts the sink and marks the job CANCELED", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 2 });
    const downloads = hangingFetch();
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    await waitFor(() => downloads.calls.length === 2);

    assert.equal(await manager.cancel(STATEMENT_ID), true);
    assert.deepEqual(sink.calls, ["abort"]);
    assert.equal((await manager.get(STATEMENT_ID))?.status, "CANCELED");
    assert.ok(downloads.calls.every((call) => call.init?.signal?.aborted === true));
    assert.equal(await manager.cancel(STATEMENT_ID), false);
    assert.equal(await manager.cancel("unknown"), false);
  });
});

test("close aborts every running job", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    const downloads = hangingFetch();
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    await waitFor(() => downloads.calls.length === 1);
    await manager.close();

    assert.deepEqual(sink.calls, ["abort"]);
    assert.equal((await manager.get(STATEMENT_ID))?.status, "CANCELED");
  });
});

test("a cancel racing with completion leaves the job SUCCEEDED and returns false", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    let releaseFinish: () => void = () => undefined;
    const finishing = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const calls: string[] = [];
    const factory = async (): Promise<ChunkSink> => ({
      write: async () => undefined,
      finish: async () => {
        calls.push("finish");
        await finishing;
        return { files: ["done.csv"] };
      },
      abort: async () => {
        calls.push("abort");
      },
    });
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: factory } }),
    );

    await manager.start(exportRequest());
    await waitFor(() => calls.includes("finish"));
    const cancelled = manager.cancel(STATEMENT_ID);
    releaseFinish();

    assert.equal(await cancelled, false);
    assert.deepEqual(calls, ["finish"]);
    const final = await manager.get(STATEMENT_ID);
    assert.equal(final?.status, "SUCCEEDED");
    assert.deepEqual(final?.files, ["done.csv"]);
  });
});

test("a failing sink write ends FAILED and aborts the sink", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 3 });
    const sink = fakeSink({
      onWrite: async (index) => {
        if (index === 1) throw new Error("disk full");
      },
    });
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.equal(final?.error, "disk full");
    assert.deepEqual(sink.calls, ["write:0", "write:1", "abort"]);
  });
});

test("a sink abort that rejects is logged and does not hide the original error", async () => {
  await withLogs("stdio", async ({ repository, logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    const factory = async (): Promise<ChunkSink> => ({
      write: async () => {
        throw new Error("write failed");
      },
      finish: async () => ({ files: [] }),
      abort: async () => {
        throw new Error("close failed");
      },
    });
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.equal(final?.error, "write failed");
    logs.flush();
    assert.equal(repository.searchLogs({ text: "close failed", level: "warn" }).total, 1);
  });
});

test("a FAILED statement ends the job FAILED with the Databricks message", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({
      chunks: 0,
      state: "FAILED",
      errorMessage: "[TABLE_OR_VIEW_NOT_FOUND] missing",
    });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.equal(final?.error, "[TABLE_OR_VIEW_NOT_FOUND] missing");
    assert.deepEqual(sink.calls, []);
  });
});

test("starting again when the export path exists rejects with InvalidArgumentError", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, cancels } = fakeStatements({ chunks: 1 });
    const fetch = async () => new Response("id\n1\n");
    const manager = createExportManager(managerDeps(logs, dir, { statements, fetch }));

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);
    assert.equal(final?.status, "SUCCEEDED");
    const path = join(dir, "exports", "sales-01ef-statement.csv");
    assert.equal(await readFile(path, "utf8"), "id\n1\n");

    await assert.rejects(manager.start(exportRequest()), InvalidArgumentError);
    assert.equal(await readFile(path, "utf8"), "id\n1\n");
    assert.deepEqual(cancels, [STATEMENT_ID]);
  });
});

test("cleanup removes .part entries older than 24 hours and keeps newer ones and finished exports", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const exportDir = join(dir, "exports");
    const { statements } = fakeStatements({ chunks: 0 });
    const manager = createExportManager(managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch }));
    await manager.cleanup();

    await mkdir(join(exportDir, "old-dir.part"), { recursive: true });
    await writeFile(join(exportDir, "old-dir.part", "part-00000.parquet"), "x");
    await writeFile(join(exportDir, "old.csv.part"), "x");
    await writeFile(join(exportDir, "new.csv.part"), "x");
    await writeFile(join(exportDir, "done.csv"), "x");
    const now = Date.now();
    const old = new Date(now - 25 * HOUR_MS);
    for (const name of ["old-dir.part", "old.csv.part", "done.csv"]) await utimes(join(exportDir, name), old, old);

    await manager.cleanup(now);

    assert.equal(await exists(join(exportDir, "old-dir.part")), false);
    assert.equal(await exists(join(exportDir, "old.csv.part")), false);
    assert.equal(await exists(join(exportDir, "new.csv.part")), true);
    assert.equal(await exists(join(exportDir, "done.csv")), true);
  });
});

test("a successful export logs start and finish with rows", async () => {
  await withLogs("stdio", async ({ repository, logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 2, rowsPerChunk: 5 });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    await manager.wait(STATEMENT_ID, 1000);
    logs.flush();

    assert.equal(repository.searchLogs({ text: "Export started" }).total, 1);
    const finished = repository.searchLogs({ text: "Export finished" });
    assert.equal(finished.total, 1);
    assert.equal(finished.results[0]?.metadata?.rows, 10);
    assert.equal(finished.results[0]?.metadata?.chunks, 2);
    assert.equal(
      finished.results.some((entry) => JSON.stringify(entry).includes("storage.example")),
      false,
    );
  });
});

test("the log execution of an export ends completed, failed or cancelled with its job", async () => {
  await withLogs("stdio", async ({ repository, logs, dir }) => {
    const statusOf = (id: string) => {
      logs.flush();
      return repository
        .recentExecutions(50)
        .find((execution) => execution.toolName === "export" && execution.executionId === id)?.status;
    };
    const exportExecutionIds = () => {
      logs.flush();
      return repository
        .recentExecutions(50)
        .filter((execution) => execution.toolName === "export")
        .map((execution) => execution.executionId);
    };

    const done = createExportManager(
      managerDeps(logs, dir, {
        statements: fakeStatements({ chunks: 1 }).statements,
        fetch: fakeFetch().fetch,
        sinks: { csv: fakeSink().factory },
      }),
    );
    await done.start(exportRequest());
    await done.wait(STATEMENT_ID, 1000);
    const [completedId] = exportExecutionIds();
    assert.equal(statusOf(completedId!), "completed");

    const failing = createExportManager(
      managerDeps(logs, dir, {
        statements: fakeStatements({ chunks: 1, state: "FAILED" }).statements,
        fetch: fakeFetch().fetch,
        sinks: { csv: fakeSink().factory },
      }),
    );
    await failing.start({ ...exportRequest(), name: "failing" });
    await failing.wait(STATEMENT_ID, 1000);
    const failedId = exportExecutionIds().find((id) => id !== completedId);
    assert.equal(statusOf(failedId!), "failed");

    const hanging = hangingFetch();
    const cancelling = createExportManager(
      managerDeps(logs, dir, {
        statements: fakeStatements({ chunks: 1 }).statements,
        fetch: hanging.fetch,
        sinks: { csv: fakeSink().factory },
      }),
    );
    await cancelling.start({ ...exportRequest(), name: "cancelling" });
    await waitFor(() => hanging.calls.length === 1);
    await cancelling.cancel(STATEMENT_ID);
    const cancelledId = exportExecutionIds().find((id) => id !== completedId && id !== failedId);
    assert.equal(statusOf(cancelledId!), "cancelled");
  });
});

/** Status per URL: the first `failures` downloads of chunk `index` get `failure`, every other one 200. */
function failingFirst(index: number, failures: number, failure: number) {
  let calls = 0;
  return (url: string) => (url.includes(`chunk-${index}?`) && calls++ < failures ? failure : 200);
}

test("a 503 on a download is retried after a wait and succeeds", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, linkRequests } = fakeStatements({ chunks: 3 });
    const downloads = fakeFetch({ status: failingFirst(1, 1, 503) });
    const sleeps: number[] = [];
    const sink = fakeSink();
    const sleep = async (ms: number) => void sleeps.push(ms);
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory }, sleep }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "SUCCEEDED");
    assert.deepEqual(sleeps, [500]);
    assert.equal(linkRequests.get(1), 1);
    assert.deepEqual(sink.calls, ["write:0", "write:1", "write:2", "finish"]);
  });
});

test("a network error on a download is retried and succeeds", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 2 });
    let thrown = 0;
    const downloads = fakeFetch({
      error: (url) => (url.includes("chunk-0?") && thrown++ === 0 ? new TypeError("fetch failed") : undefined),
    });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "SUCCEEDED");
    assert.equal(downloads.calls.filter((call) => call.url.includes("chunk-0?")).length, 2);
  });
});

test("a persistent 5xx fails after 3 retries with growing waits, naming the chunk and logging each retry", async () => {
  await withLogs("stdio", async ({ repository, logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 2 });
    const downloads = fakeFetch({ status: (url) => (url.includes("chunk-1?") ? 502 : 200) });
    const sleeps: number[] = [];
    const sink = fakeSink();
    const sleep = async (ms: number) => void sleeps.push(ms);
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory }, sleep }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.match(final?.error ?? "", /chunk 1.*HTTP 502/);
    assert.equal(downloads.calls.filter((call) => call.url.includes("chunk-1?")).length, 4);
    assert.deepEqual(sleeps, [500, 1000, 2000]);
    assert.equal(sink.calls.at(-1), "abort");
    logs.flush();
    const retries = repository.searchLogs({ text: "Export chunk download retried", level: "warn" });
    assert.equal(retries.total, 3);
    assert.deepEqual(
      retries.results.map((entry) => [entry.metadata?.chunk, entry.metadata?.status]),
      [
        [1, 502],
        [1, 502],
        [1, 502],
      ],
    );
    assert.equal(
      retries.results.some((entry) => JSON.stringify(entry).includes("storage.example")),
      false,
    );
  });
});

test("a cancel during a retry wait stops the job promptly", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    const downloads = fakeFetch({ status: () => 503 });
    const sink = fakeSink();
    let retryWaits = 0;
    const sleep = (ms: number) => {
      if (ms !== 500) return Promise.resolve();
      retryWaits += 1;
      return new Promise<void>(() => undefined);
    };
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory }, sleep }),
    );

    await manager.start(exportRequest());
    await waitFor(() => retryWaits === 1);

    assert.equal(await manager.cancel(STATEMENT_ID), true);
    assert.equal((await manager.get(STATEMENT_ID))?.status, "CANCELED");
    assert.deepEqual(sink.calls, ["abort"]);
    assert.equal(downloads.calls.length, 1);
  });
});

test("a 404 on a download fails at once without retry", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, linkRequests } = fakeStatements({ chunks: 1 });
    const downloads = fakeFetch({ status: () => 404 });
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.match(final?.error ?? "", /chunk 0.*HTTP 404/);
    assert.equal(downloads.calls.length, 1);
    assert.equal(linkRequests.get(0), 1);
  });
});

test("a failed download stops the job without waiting for earlier chunks", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 5 });
    const hanging = hangingFetch();
    const fast = fakeFetch({ status: (url) => (url.includes("chunk-3?") ? 404 : 200) });
    const fetch = (url: string, init?: RequestInit) =>
      url.includes("chunk-0?") ? hanging.fetch(url, init) : fast.fetch(url, init);
    const sink = fakeSink();
    const manager = createExportManager(managerDeps(logs, dir, { statements, fetch, sinks: { csv: sink.factory } }));

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.match(final?.error ?? "", /chunk 3/);
    assert.equal(hanging.calls[0]?.init?.signal?.aborted, true);
    assert.deepEqual(sink.calls, ["abort"]);
  });
});

test("a rejected finish fails the job and aborts the sink once", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    const calls: string[] = [];
    const factory = async (): Promise<ChunkSink> => ({
      write: async () => undefined,
      finish: async () => {
        calls.push("finish");
        throw new Error("rename failed");
      },
      abort: async () => {
        calls.push("abort");
      },
    });
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.equal(final?.error, "rename failed");
    assert.deepEqual(calls, ["finish", "abort"]);
  });
});

test("a cancel arriving while a failure is being cleaned up keeps the job FAILED", async () => {
  await withLogs("stdio", async ({ repository, logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    const calls: string[] = [];
    let releaseAbort: () => void = () => undefined;
    const factory = async (): Promise<ChunkSink> => ({
      write: async () => {
        throw new Error("write failed");
      },
      finish: async () => ({ files: [] }),
      abort: async () => {
        calls.push("abort");
        await new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
      },
    });
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: factory } }),
    );

    await manager.start(exportRequest());
    await waitFor(() => calls.includes("abort"));
    const cancelled = manager.cancel(STATEMENT_ID);
    releaseAbort();

    assert.equal(await cancelled, false);
    const final = await manager.get(STATEMENT_ID);
    assert.equal(final?.status, "FAILED");
    assert.equal(final?.error, "write failed");
    logs.flush();
    assert.equal(repository.searchLogs({ text: "write failed", level: "error" }).total, 1);
  });
});

test("no download beyond the look-ahead window starts before the first chunk is written", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 6 });
    let releaseFirst: () => void = () => undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const fetch = async (url: string) => {
      const index = Number(/chunk-(\d+)/.exec(url)?.[1]);
      started.push(index);
      if (index === 0) await firstReleased;
      return new Response(`chunk-${index}`);
    };
    const sink = fakeSink();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch, concurrency: 2, sinks: { csv: sink.factory } }),
    );

    await manager.start(exportRequest());
    await waitFor(() => started.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([...started].sort(), [0, 1, 2, 3]);

    releaseFirst();
    const final = await manager.wait(STATEMENT_ID, 1000);
    assert.equal(final?.status, "SUCCEEDED");
    assert.deepEqual(sink.calls, ["write:0", "write:1", "write:2", "write:3", "write:4", "write:5", "finish"]);
  });
});

test("a cancel while the statement is still pending ends the job CANCELED without downloads", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, awaited, cancels } = fakeStatements({ chunks: 0, pending: true });
    const downloads = fakeFetch();
    const manager = createExportManager(managerDeps(logs, dir, { statements, fetch: downloads.fetch }));

    await manager.start(exportRequest());
    await waitFor(() => awaited.length === 1);

    assert.equal(await manager.cancel(STATEMENT_ID), true);
    assert.equal((await manager.get(STATEMENT_ID))?.status, "CANCELED");
    assert.deepEqual(cancels, [STATEMENT_ID]);
    assert.deepEqual(awaited, [STATEMENT_ID]);
    assert.equal(downloads.calls.length, 0);
  });
});

test("cleanupOrphanedParts removes old .part entries, keeps new ones and ignores a missing directory", async () => {
  await withLogs("stdio", async ({ dir }) => {
    const exportDir = join(dir, "exports");
    await cleanupOrphanedParts(exportDir);
    assert.equal(await exists(exportDir), false);

    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, "old.csv.part"), "x");
    await writeFile(join(exportDir, "new.csv.part"), "x");
    await writeFile(join(exportDir, "done.csv"), "x");
    const now = Date.now();
    const old = new Date(now - 25 * HOUR_MS);
    for (const name of ["old.csv.part", "done.csv"]) await utimes(join(exportDir, name), old, old);

    await cleanupOrphanedParts(exportDir, now);

    assert.equal(await exists(join(exportDir, "old.csv.part")), false);
    assert.equal(await exists(join(exportDir, "new.csv.part")), true);
    assert.equal(await exists(join(exportDir, "done.csv")), true);
  });
});

test("cleanup skips an entry removed between listing and stat, and keeps going", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const exportDir = join(dir, "exports");
    const { statements } = fakeStatements({ chunks: 0 });
    const manager = createExportManager(managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch }));
    await mkdir(exportDir, { recursive: true });
    const now = Date.now();
    const old = new Date(now - 25 * HOUR_MS);
    for (const name of ["a.csv.part", "b.csv.part"]) {
      await writeFile(join(exportDir, name), "x");
      await utimes(join(exportDir, name), old, old);
    }
    // Another process removes a.csv.part right after it was listed.
    const realLstat = fsPromises.lstat;
    mock.method(fsPromises, "lstat", async (path: string) => {
      if (path.endsWith("a.csv.part")) await rm(path);
      return realLstat(path);
    });
    syncBuiltinESMExports();
    try {
      await manager.cleanup(now);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }

    assert.equal(await exists(join(exportDir, "b.csv.part")), false);
  });
});

test("cancel also cancels the Databricks statement once", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, cancels } = fakeStatements({ chunks: 2 });
    const downloads = hangingFetch();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: fakeSink().factory } }),
    );

    await manager.start(exportRequest());
    await waitFor(() => downloads.calls.length === 2);
    assert.equal(await manager.cancel(STATEMENT_ID), true);
    assert.equal(await manager.cancel(STATEMENT_ID), false);

    assert.deepEqual(cancels, [STATEMENT_ID]);
  });
});

test("close cancels the Databricks statement of every running job", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    // The statements never finish, so both jobs stay PENDING until they are cancelled.
    const { statements, cancels } = fakeStatements({ chunks: 0, pending: true, ids: ["st-a", "st-b"] });
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: hangingFetch().fetch, sinks: { csv: fakeSink().factory } }),
    );

    await manager.start({ ...exportRequest(), name: "a" });
    await manager.start({ ...exportRequest(), name: "b" });
    await manager.close();

    assert.deepEqual(cancels.sort(), ["st-a", "st-b"]);
    assert.equal((await manager.get("st-a"))?.status, "CANCELED");
    assert.equal((await manager.get("st-b"))?.status, "CANCELED");
  });
});

test("a closed manager refuses to start an export and submits nothing", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    let submissions = 0;
    const submitExport = statements.submitExport;
    statements.submitExport = (...args) => {
      submissions++;
      return submitExport(...args);
    };
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: fakeSink().factory } }),
    );

    await manager.close();
    await assert.rejects(
      manager.start(exportRequest()),
      (error: unknown) => error instanceof DakError && /shutting down/.test(error.message),
    );
    assert.equal(submissions, 0);
  });
});

test("an export whose submission is still running when the manager closes is cancelled and not started", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, cancels } = fakeStatements({ chunks: 1 });
    let release: () => void = () => undefined;
    let submitting: () => void = () => undefined;
    const submissionStarted = new Promise<void>((resolve) => {
      submitting = resolve;
    });
    statements.submitExport = async () => {
      submitting();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { statementId: STATEMENT_ID, warehouseId: "wh1" };
    };
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: fakeFetch().fetch, sinks: { csv: fakeSink().factory } }),
    );

    const starting = manager.start(exportRequest());
    const rejected = assert.rejects(
      starting,
      (error: unknown) => error instanceof DakError && /shutting down/.test(error.message),
    );
    await submissionStarted;
    await manager.close();
    release();
    await rejected;

    assert.deepEqual(cancels, [STATEMENT_ID]);
    assert.equal(await manager.get(STATEMENT_ID), undefined);
  });
});

test("a failing statement cancel does not change the cancelled job", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { statements, cancels } = fakeStatements({ chunks: 1, cancelFails: true });
    const downloads = hangingFetch();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: fakeSink().factory } }),
    );

    await manager.start(exportRequest());
    await waitFor(() => downloads.calls.length === 1);
    assert.equal(await manager.cancel(STATEMENT_ID), true);

    assert.equal(cancels.length, 1);
    const final = await manager.get(STATEMENT_ID);
    assert.equal(final?.status, "CANCELED");
    assert.equal(final?.error, undefined);
  });
});

test("a download error that holds a presigned URL never reaches the state or the logs", async () => {
  await withLogs("stdio", async ({ repository, logs, dir }) => {
    const { statements } = fakeStatements({ chunks: 1 });
    const downloads = fakeFetch({
      error: (url) => new TypeError(`Failed to parse URL from ${url}&X-Amz-Signature=secret`),
    });
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: fakeSink().factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "FAILED");
    assert.match(final?.error ?? "", /chunk 0 download failed \(Failed to parse URL from <url>\)/);
    assert.equal(JSON.stringify(final).includes("storage.example"), false);
    logs.flush();
    for (const text of ["storage.example", "X-Amz-Signature"])
      assert.equal(repository.searchLogs({ text }).total, 0, text);
    assert.ok(repository.searchLogs({ text: "<url>" }).total > 0);
  });
});

test("a link whose expiration has passed is renewed before any download", async () => {
  await withLogs("stdio", async ({ repository, logs, dir }) => {
    // The finished statement carries the first link inline, already expired.
    const staleLink = {
      url: "https://storage.example/chunk-0?stale",
      rowCount: 10,
      expiration: "2020-01-01T00:00:00.000Z",
    };
    const { statements, linkRequests } = fakeStatements({ chunks: 1, firstLink: staleLink });
    const downloads = fakeFetch();
    const manager = createExportManager(
      managerDeps(logs, dir, { statements, fetch: downloads.fetch, sinks: { csv: fakeSink().factory } }),
    );

    await manager.start(exportRequest());
    const final = await manager.wait(STATEMENT_ID, 1000);

    assert.equal(final?.status, "SUCCEEDED");
    assert.equal(linkRequests.get(0), 1);
    assert.deepEqual(
      downloads.calls.map((call) => call.url),
      ["https://storage.example/chunk-0?attempt=1"],
    );
    logs.flush();
    const refreshed = repository.searchLogs({ text: "Export chunk link refreshed", level: "warn" });
    assert.deepEqual(
      refreshed.results.map((entry) => entry.metadata?.reason),
      ["link expired"],
    );
  });
});
