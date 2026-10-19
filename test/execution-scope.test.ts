import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidArgumentError } from "../src/errors.ts";
import { createExecutionScope, ExecutionCancelled } from "../src/execution-scope.ts";
import type { LogRepository } from "../src/logging/repository.ts";
import type { LogService } from "../src/logging/service.ts";
import { withLogs } from "./helpers.ts";

type Context = { repository: LogRepository; logs: LogService };

/** The one execution recorded for `toolName` and its log entries. */
function recorded(context: Context, toolName: string) {
  context.logs.flush();
  const executions = context.repository.recentExecutions(50).filter((candidate) => candidate.toolName === toolName);
  assert.equal(executions.length, 1, `one execution of ${toolName}`);
  const [execution] = executions;
  return { execution: execution!, entries: context.repository.executionDetail(execution!.executionId)?.logs ?? [] };
}

const tick = (ms = 1) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const entry = { message: "Tool call completed", arguments: { statement: "SELECT 1" }, summarize: (result: { state: string; rows: number }) => ({ state: result.state, rowCount: result.rows }) };

test("a successful run writes exactly one info entry with arguments, duration and result summary, and completes the execution", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    const result = await scope.run({ toolName: "t" }, async () => ({ state: "SUCCEEDED", rows: 3 }), entry);
    assert.deepEqual(result, { state: "SUCCEEDED", rows: 3 });
    const { execution, entries } = recorded(context, "t");
    assert.equal(execution.status, "completed");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, "info");
    assert.equal(entries[0]?.message, "Tool call completed");
    assert.equal(entries[0]?.source, "t");
    assert.equal(entries[0]?.metadata?.statement, "SELECT 1");
    assert.equal(entries[0]?.metadata?.state, "SUCCEEDED");
    assert.equal(entries[0]?.metadata?.rowCount, 3);
    assert.equal(typeof entries[0]?.metadata?.durationMs, "number");
  });
});

test("a run without an entry writes nothing on success and completes the execution", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    await scope.run({ resourceUri: "resource://x" }, async () => "payload");
    context.logs.flush();
    const execution = context.repository.recentExecutions(50).find((candidate) => candidate.resourceUri === "resource://x");
    assert.equal(execution?.status, "completed");
    assert.deepEqual(context.repository.executionDetail(execution!.executionId)?.logs, []);
  });
});

test("an expected error is one warn entry without stack trace, carries arguments and duration, fails the execution and is rethrown", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    const failure = new InvalidArgumentError("bad input");
    await assert.rejects(scope.run({ toolName: "t" }, async () => Promise.reject(failure), entry), (error: unknown) => error === failure);
    const { execution, entries } = recorded(context, "t");
    assert.equal(execution.status, "failed");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, "warn");
    assert.equal(entries[0]?.stackTrace, undefined);
    assert.equal(entries[0]?.message, "bad input");
    assert.equal(entries[0]?.metadata?.statement, "SELECT 1");
    assert.equal(typeof entries[0]?.metadata?.durationMs, "number");
    assert.equal(entries[0]?.metadata?.state, undefined);
  });
});

test("an unexpected error is one error entry with its stack trace and fails the execution", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    await assert.rejects(scope.run({ toolName: "t" }, async () => Promise.reject(new Error("driver crashed")), entry), /driver crashed/);
    const { execution, entries } = recorded(context, "t");
    assert.equal(execution.status, "failed");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, "error");
    assert.match(entries[0]?.stackTrace ?? "", /Error: driver crashed/);
    assert.equal(entries[0]?.metadata?.statement, "SELECT 1");
  });
});

test("a failure of a run without an entry is one entry without metadata", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    await assert.rejects(scope.run({ toolName: "t" }, async () => Promise.reject(new InvalidArgumentError("nope"))), /nope/);
    const { entries } = recorded(context, "t");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, "warn");
    assert.equal(entries[0]?.metadata, undefined);
  });
});

test("ExecutionCancelled cancels the execution without an entry and is rethrown", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    await assert.rejects(scope.run({ toolName: "t" }, async () => Promise.reject(new ExecutionCancelled()), entry), ExecutionCancelled);
    const { execution, entries } = recorded(context, "t");
    assert.equal(execution.status, "cancelled");
    assert.deepEqual(entries, []);
  });
});

test("diagnostics annotated inside the run, also after awaits, reach the success entry and the failure entry", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    await scope.run(
      { toolName: "ok" },
      async () => {
        await tick();
        scope.annotate({ checkMs: 7 });
        await tick();
        scope.annotate({ warehouseId: "wh1" });
        return { state: "SUCCEEDED", rows: 1 };
      },
      entry,
    );
    await scope
      .run(
        { toolName: "ko" },
        async () => {
          scope.annotate({ checkMs: 9 });
          throw new InvalidArgumentError("later");
        },
        entry,
      )
      .catch(() => undefined);
    const ok = recorded(context, "ok").entries[0]?.metadata;
    assert.equal(ok?.checkMs, 7);
    assert.equal(ok?.warehouseId, "wh1");
    assert.equal(recorded(context, "ko").entries[0]?.metadata?.checkMs, 9);
  });
});

test("concurrent runs keep their diagnostics and entries apart", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    const call = (toolName: string, checkMs: number, delayMs: number) =>
      scope.run(
        { toolName },
        async () => {
          await tick(delayMs);
          scope.annotate({ checkMs });
          await tick(delayMs);
          return { state: toolName, rows: checkMs };
        },
        entry,
      );
    await Promise.all([call("slow", 1, 15), call("fast", 2, 1), call("middle", 3, 7)]);
    for (const [toolName, checkMs] of [["slow", 1], ["fast", 2], ["middle", 3]] as const) {
      const { entries } = recorded(context, toolName);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.metadata?.checkMs, checkMs);
      assert.equal(entries[0]?.metadata?.state, toolName);
    }
  });
});

test("annotate outside any run is ignored and does not leak into later runs", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    scope.annotate({ checkMs: 99 });
    await scope.run({ toolName: "t" }, async () => ({ state: "SUCCEEDED", rows: 0 }), entry);
    assert.equal(recorded(context, "t").entries[0]?.metadata?.checkMs, undefined);
  });
});

test("the work gets its own execution and is the current one while it runs", async () => {
  await withLogs("stdio", async (context) => {
    const scope = createExecutionScope(context.logs);
    await scope.run({ toolName: "t" }, async (execution) => {
      assert.equal(context.logs.current(), execution);
      await tick();
      assert.equal(context.logs.current(), execution);
      execution.info("inside the work");
    });
    assert.equal(context.logs.current(), context.logs.lifecycle);
    const { entries } = recorded(context, "t");
    assert.deepEqual(entries.map((logged) => logged.message), ["inside the work"]);
  });
});
