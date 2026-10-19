import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLogRepository, type LogRepository } from "../src/logging/repository.ts";

async function withRepository(run: (repository: LogRepository, dir: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "dak-logs-"));
  const repository = await openLogRepository(join(dir, "nested", "logs.db"));
  try {
    await run(repository, dir);
  } finally {
    repository.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const DAY = 86_400_000;

function seed(repository: LogRepository, now: number) {
  repository.writeBatch([
    {
      type: "execution-start",
      execution: {
        executionId: "e-old",
        startedAt: now - 100 * DAY,
        transport: "stdio",
        toolName: "execute_sql",
        status: "started",
      },
    },
    {
      type: "log",
      entry: {
        executionId: "e-old",
        timestamp: now - 89 * DAY,
        level: "info",
        message: "late log of an old execution",
      },
    },
    {
      type: "execution-start",
      execution: {
        executionId: "e1",
        startedAt: now - 2_000,
        transport: "stdio",
        toolName: "execute_sql",
        status: "started",
      },
    },
    {
      type: "log",
      entry: {
        executionId: "e1",
        timestamp: now - 1_900,
        level: "info",
        category: "tool",
        source: "execute_sql",
        message: "Executing SQL",
        metadata: { statement: "SELECT 1" },
      },
    },
    {
      type: "log",
      entry: {
        executionId: "e1",
        timestamp: now - 1_800,
        level: "error",
        category: "tool",
        source: "execute_sql",
        message: "Statement failed",
        stackTrace: "Error: boom",
      },
    },
    { type: "execution-end", executionId: "e1", finishedAt: now - 1_700, status: "failed" },
    {
      type: "execution-start",
      execution: {
        executionId: "e2",
        startedAt: now - 1_000,
        transport: "http",
        resourceUri: "resource://logs/stats",
        status: "started",
      },
    },
    { type: "log", entry: { executionId: "e2", timestamp: now - 900, level: "warn", message: "Slow read" } },
    { type: "execution-end", executionId: "e2", finishedAt: now - 800, status: "completed" },
  ]);
}

test("opens the database with the required PRAGMAs, schema and indexes", async () => {
  await withRepository((repository) => {
    const info = repository.inspect();
    assert.equal(info.journalMode, "wal");
    assert.equal(info.synchronous, 1);
    assert.equal(info.foreignKeys, 1);
    assert.equal(info.tempStore, 2);
    assert.equal(info.busyTimeout, 5000);
    for (const index of ["idx_logs_execution", "idx_logs_timestamp", "idx_logs_level", "idx_logs_category"]) {
      assert.ok(info.indexes.includes(index), index);
    }
    assert.deepEqual(info.tables.sort(), ["executions", "logs"]);
  });
});

test("the database and its directory are owner-only", {
  skip: process.platform === "win32" && "POSIX permissions",
}, async () => {
  await withRepository(async (_repository, dir) => {
    assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "nested", "logs.db"))).mode & 0o777, 0o600);
  });
});

test("reopening an existing database keeps its data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dak-logs-"));
  const path = join(dir, "logs.db");
  try {
    const first = await openLogRepository(path);
    seed(first, Date.now());
    first.close();
    const second = await openLogRepository(path);
    assert.equal(second.recentExecutions(10).length, 3);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("execution detail returns the execution and its ordered logs", async () => {
  await withRepository((repository) => {
    const now = Date.now();
    seed(repository, now);
    const detail = repository.executionDetail("e1");
    assert.ok(detail);
    assert.deepEqual(detail.execution, {
      executionId: "e1",
      startedAt: now - 2_000,
      finishedAt: now - 1_700,
      transport: "stdio",
      toolName: "execute_sql",
      status: "failed",
    });
    assert.deepEqual(
      detail.logs.map((log) => log.message),
      ["Executing SQL", "Statement failed"],
    );
    assert.deepEqual(detail.logs[0]!.metadata, { statement: "SELECT 1" });
    assert.equal(detail.logs[1]!.stackTrace, "Error: boom");
    assert.equal(repository.executionDetail("missing"), undefined);
  });
});

test("recent errors, recent executions and stats", async () => {
  await withRepository((repository) => {
    const now = Date.now();
    seed(repository, now);
    assert.deepEqual(
      repository.recentErrors(10).map((log) => log.message),
      ["Statement failed"],
    );
    assert.deepEqual(
      repository.recentExecutions(2).map((execution) => execution.executionId),
      ["e2", "e1"],
    );
    assert.deepEqual(repository.stats(now - DAY), { executions: 2, errors: 1, warnings: 1 });
  });
});

test("searchLogs filters by level, text, execution and time range and reports the total", async () => {
  await withRepository((repository) => {
    const now = Date.now();
    seed(repository, now);
    assert.equal(repository.searchLogs({ level: "error" }).total, 1);
    assert.deepEqual(
      repository.searchLogs({ text: "select 1" }).results.map((log) => log.message),
      ["Executing SQL"],
    );
    assert.equal(repository.searchLogs({ executionId: "e2" }).total, 1);
    assert.equal(
      repository.searchLogs({ from: new Date(now - 1_850).toISOString(), to: new Date(now).toISOString() }).total,
      2,
    );
    const limited = repository.searchLogs({ limit: 1 });
    assert.equal(limited.results.length, 1);
    assert.equal(limited.total, 4);
  });
});

test("purge removes old executions with their logs and old orphan logs", async () => {
  await withRepository((repository) => {
    const now = Date.now();
    seed(repository, now);
    repository.purge(now - 90 * DAY);
    assert.equal(repository.executionDetail("e-old"), undefined);
    assert.equal(repository.searchLogs({ executionId: "e-old" }).total, 0);
    assert.equal(repository.recentExecutions(10).length, 2);
  });
});
