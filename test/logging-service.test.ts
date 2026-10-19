import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadOnlyViolationError } from "../src/statements.ts";
import { createLogService } from "../src/logging/service.ts";
import type { LogRepository, QueueEvent } from "../src/logging/repository.ts";

function memoryRepository() {
  const batches: QueueEvent[][] = [];
  const purges: number[] = [];
  let closed = false;
  const repository = {
    writeBatch: (events: QueueEvent[]) => {
      batches.push([...events]);
    },
    purge: (cutoff: number) => {
      purges.push(cutoff);
    },
    close: () => {
      closed = true;
    },
  } as unknown as LogRepository;
  return { repository, batches, purges, isClosed: () => closed, events: () => batches.flat() };
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("starts a lifecycle execution and purges at startup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10 * 86_400_000 * 10 });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  assert.equal(memory.purges.length, 1);
  assert.equal(memory.purges[0], Date.now() - 90 * 86_400_000);
  t.mock.timers.tick(5_000);
  const [start, log] = memory.events();
  assert.equal(start?.type, "execution-start");
  assert.equal(log?.type, "log");
  service.close();
});

test("flushes after 5 seconds in one batch, preserving FIFO order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  t.mock.timers.tick(5_000);
  memory.batches.length = 0;
  const execution = service.startExecution({ toolName: "execute_sql" });
  execution.info("one");
  execution.info("two");
  execution.complete();
  assert.equal(memory.batches.length, 0);
  t.mock.timers.tick(4_999);
  assert.equal(memory.batches.length, 0);
  t.mock.timers.tick(1);
  assert.equal(memory.batches.length, 1);
  assert.deepEqual(
    memory.batches[0]!.map((event) => (event.type === "log" ? event.entry.message : event.type)),
    ["execution-start", "one", "two", "execution-end"],
  );
  service.close();
});

test("flushes when 100 events are pending without waiting for the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  t.mock.timers.tick(5_000);
  memory.batches.length = 0;
  const execution = service.startExecution({ toolName: "list_objects" });
  for (let index = 0; index < 99; index++) execution.info(`event ${index}`);
  assert.equal(memory.batches.length, 0);
  await nextTick();
  assert.equal(memory.batches.length, 1);
  assert.equal(memory.batches[0]!.length, 100);
  service.close();
});

test("failed executions record the error, stack trace and failed status", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "http", level: "info" });
  const execution = service.startExecution({ resourceUri: "resource://logs/stats" });
  execution.fail(new Error("boom"));
  service.close();
  const events = memory.events();
  const start = events.find(
    (event) => event.type === "execution-start" && event.execution.executionId === execution.executionId,
  );
  assert.ok(start && start.type === "execution-start");
  assert.equal(start.execution.transport, "http");
  assert.equal(start.execution.resourceUri, "resource://logs/stats");
  const error = events.find((event) => event.type === "log" && event.entry.level === "error");
  assert.ok(error && error.type === "log");
  assert.equal(error.entry.message, "boom");
  assert.match(error.entry.stackTrace ?? "", /Error: boom/);
  const end = events.find((event) => event.type === "execution-end" && event.executionId === execution.executionId);
  assert.ok(end && end.type === "execution-end");
  assert.equal(end.status, "failed");
});

test("cancelled executions are marked as cancelled", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  const execution = service.startExecution({ toolName: "execute_sql" });
  execution.cancel();
  service.close();
  const end = memory
    .events()
    .find((event) => event.type === "execution-end" && event.executionId === execution.executionId);
  assert.ok(end && end.type === "execution-end" && end.status === "cancelled");
});

test("entries below the configured level are dropped; executions are always recorded", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "warn" });
  const execution = service.startExecution({ toolName: "execute_sql" });
  execution.debug("hidden");
  execution.info("hidden");
  execution.warn("visible");
  execution.complete();
  service.close();
  const messages = memory.events().flatMap((event) => (event.type === "log" ? [event.entry.message] : []));
  assert.ok(messages.includes("visible"));
  assert.ok(!messages.includes("hidden"));
  assert.ok(
    memory
      .events()
      .some((event) => event.type === "execution-start" && event.execution.executionId === execution.executionId),
  );
});

test("secrets are redacted from metadata", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  const execution = service.startExecution({ toolName: "x" });
  execution.info("call", {
    statement: "SELECT 1",
    token: "dapi123",
    nested: { client_secret: "s", Authorization: "Bearer x", keep: 1 },
  });
  service.close();
  const entry = memory.events().find((event) => event.type === "log" && event.entry.message === "call");
  assert.ok(entry && entry.type === "log");
  assert.deepEqual(entry.entry.metadata, {
    statement: "SELECT 1",
    token: "[REDACTED]",
    nested: { client_secret: "[REDACTED]", Authorization: "[REDACTED]", keep: 1 },
  });
});

test("purges every 24 hours and close flushes, stops timers and closes the repository", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  t.mock.timers.tick(86_400_000);
  assert.equal(memory.purges.length, 2);
  service.startExecution({ toolName: "x" }).info("pending");
  service.close();
  assert.ok(memory.events().some((event) => event.type === "log" && event.entry.message === "pending"));
  assert.ok(memory.isClosed());
  const lifecycleEnd = memory
    .events()
    .filter((event) => event.type === "execution-end")
    .at(-1);
  assert.ok(lifecycleEnd && lifecycleEnd.type === "execution-end" && lifecycleEnd.status === "completed");
  const purgesBefore = memory.purges.length;
  t.mock.timers.tick(86_400_000);
  assert.equal(memory.purges.length, purgesBefore);
});

test("the service never writes to stdout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const writes: unknown[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const memory = memoryRepository();
    const service = createLogService({ repository: memory.repository, transport: "stdio", level: "trace" });
    const execution = service.startExecution({ toolName: "x" });
    execution.error("bad", undefined, new Error("x"));
    execution.complete();
    service.close();
  } finally {
    process.stdout.write = original;
  }
  assert.equal(writes.length, 0);
});

test("fail logs a DakError as warn without stack trace and any other error as error with stack trace", () => {
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  const rejected = service.startExecution({ toolName: "execute_sql" });
  rejected.fail(new ReadOnlyViolationError("x"));
  const crashed = service.startExecution({ toolName: "execute_sql" });
  crashed.fail(new Error("boom"));
  service.flush();
  const logs = memory.events().flatMap((event) => (event.type === "log" ? [event.entry] : []));
  const warning = logs.find((entry) => entry.executionId === rejected.executionId);
  assert.equal(warning?.level, "warn");
  assert.equal(warning?.message, "x");
  assert.equal(warning?.stackTrace, undefined);
  const failure = logs.find((entry) => entry.executionId === crashed.executionId);
  assert.equal(failure?.level, "error");
  assert.match(failure?.stackTrace ?? "", /Error: boom/);
  const ends = memory.events().flatMap((event) => (event.type === "execution-end" ? [event] : []));
  assert.equal(ends.find((event) => event.executionId === rejected.executionId)?.status, "failed");
  assert.equal(ends.find((event) => event.executionId === crashed.executionId)?.status, "failed");
  service.close();
});

test("run scopes current() to the given execution across awaits and falls back to the lifecycle", async () => {
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  const handle = service.startExecution({ toolName: "execute_sql" });
  const inside = await service.run(handle, async () => {
    await Promise.resolve();
    return service.current();
  });
  assert.equal(inside, handle);
  assert.equal(service.current(), service.lifecycle);
  service.close();
});

test("fail writes its metadata, redacted, into the single warn or error entry", () => {
  const memory = memoryRepository();
  const service = createLogService({ repository: memory.repository, transport: "stdio", level: "info" });
  const rejected = service.startExecution({ toolName: "execute_sql" });
  rejected.fail(new ReadOnlyViolationError("x"), { statement: "DELETE FROM t", apiToken: "abc" });
  const crashed = service.startExecution({ toolName: "execute_sql" });
  crashed.fail(new Error("boom"), { durationMs: 3 });
  service.flush();
  const logs = memory.events().flatMap((event) => (event.type === "log" ? [event.entry] : []));
  const warnings = logs.filter((entry) => entry.executionId === rejected.executionId);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.level, "warn");
  assert.deepEqual(warnings[0]?.metadata, { statement: "DELETE FROM t", apiToken: "[REDACTED]" });
  const failures = logs.filter((entry) => entry.executionId === crashed.executionId);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.level, "error");
  assert.deepEqual(failures[0]?.metadata, { durationMs: 3 });
  assert.match(failures[0]?.stackTrace ?? "", /Error: boom/);
  service.close();
});
