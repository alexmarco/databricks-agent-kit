import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExportManager } from "../src/export/manager.ts";
import type { ExportState } from "../src/export/types.ts";
import { createStatementLookup } from "../src/statement-lookup.ts";
import type { StatementLifecycle, StatementResult } from "../src/statements.ts";

const plainResult: StatementResult = { statementId: "st-plain", state: "SUCCEEDED", columns: [{ name: "x", type: "INT" }], rows: [["1"]], rowCount: 1, truncated: false };

function exportState(status: ExportState["status"]): ExportState {
  return { id: "export-1", statementId: "st-export", format: "csv", path: "/exports/export-1.csv", status };
}

/** Fakes of the two modules the lookup composes; calls are recorded, `waitResult` is what waiting for an export returns. */
function fakes(exportsByStatement: Record<string, ExportState>, waitResult?: ExportState) {
  const calls = {
    get: [] as Array<{ statementId: string; options: unknown }>,
    cancelStatement: [] as string[],
    wait: [] as Array<{ statementId: string; timeoutMs: number }>,
    cancelExport: [] as string[],
  };
  const statements = {
    get: async (statementId: string, options?: unknown) => {
      calls.get.push({ statementId, options });
      return { ...plainResult, statementId };
    },
    cancel: async (statementId: string) => {
      calls.cancelStatement.push(statementId);
    },
  } as unknown as Pick<StatementLifecycle, "get" | "cancel">;
  const exports = {
    get: async (statementId: string) => structuredClone(exportsByStatement[statementId]),
    wait: async (statementId: string, timeoutMs: number) => {
      calls.wait.push({ statementId, timeoutMs });
      return structuredClone(waitResult ?? exportsByStatement[statementId]);
    },
    cancel: async (statementId: string) => {
      calls.cancelExport.push(statementId);
      const state = exportsByStatement[statementId];
      if (state === undefined || ["SUCCEEDED", "FAILED", "CANCELED"].includes(state.status)) return false;
      state.status = "CANCELED";
      return true;
    },
  } as unknown as Pick<ExportManager, "get" | "wait" | "cancel">;
  return { statements, exports, lookup: createStatementLookup({ statements, exports }), calls };
}

test("get answers a running export with its state and does not wait without a wait time", async () => {
  const { lookup, calls } = fakes({ "st-export": exportState("DOWNLOADING") });
  assert.deepEqual(await lookup.get("st-export", {}), { statementId: "st-export", export: exportState("DOWNLOADING") });
  assert.deepEqual(await lookup.get("st-export", { waitSeconds: 0 }), { statementId: "st-export", export: exportState("DOWNLOADING") });
  assert.deepEqual(calls.wait, []);
  assert.deepEqual(calls.get, []);
});

test("get waits for an export up to the wait time and returns its state at that moment", async () => {
  const { lookup, calls } = fakes({ "st-export": exportState("DOWNLOADING") }, exportState("SUCCEEDED"));
  assert.deepEqual(await lookup.get("st-export", { waitSeconds: 3 }), { statementId: "st-export", export: exportState("SUCCEEDED") });
  assert.deepEqual(calls.wait, [{ statementId: "st-export", timeoutMs: 3000 }]);
  assert.deepEqual(calls.get, []);
});

test("get answers a finished export with its final state", async () => {
  const { lookup } = fakes({ "st-export": exportState("SUCCEEDED") });
  assert.deepEqual(await lookup.get("st-export", {}), { statementId: "st-export", export: exportState("SUCCEEDED") });
});

test("get forwards a plain or unknown statement id and its wait time to the statement lifecycle", async () => {
  const { lookup, calls } = fakes({ "st-export": exportState("PENDING") });
  assert.deepEqual(await lookup.get("st-other", { waitSeconds: 2 }), { ...plainResult, statementId: "st-other" });
  assert.deepEqual(await lookup.get("st-other", {}), { ...plainResult, statementId: "st-other" });
  assert.deepEqual(calls.get, [
    { statementId: "st-other", options: { waitSeconds: 2 } },
    { statementId: "st-other", options: { waitSeconds: undefined } },
  ]);
  assert.deepEqual(calls.wait, []);
});

test("cancel stops a running export through the export manager only", async () => {
  const { lookup, calls } = fakes({ "st-export": exportState("DOWNLOADING") });
  assert.deepEqual(await lookup.cancel("st-export"), { statementId: "st-export", cancelled: true });
  assert.deepEqual(calls.cancelExport, ["st-export"]);
  // The export manager cancels the Databricks statement of an export itself.
  assert.deepEqual(calls.cancelStatement, []);
});

test("cancel does not report a finished export as cancelled and returns its state", async () => {
  const { lookup, calls } = fakes({ "st-export": exportState("SUCCEEDED") });
  assert.deepEqual(await lookup.cancel("st-export"), { statementId: "st-export", cancelled: false, export: exportState("SUCCEEDED") });
  assert.deepEqual(calls.cancelStatement, []);
});

test("cancel sends a plain or unknown statement id to the statement lifecycle", async () => {
  const { lookup, calls } = fakes({ "st-export": exportState("PENDING") });
  assert.deepEqual(await lookup.cancel("st-plain"), { statementId: "st-plain", cancelled: true });
  assert.deepEqual(calls.cancelStatement, ["st-plain"]);
  assert.deepEqual(calls.cancelExport, []);
});

test("cancel lets the error of the statement lifecycle reach the caller", async () => {
  const { exports } = fakes({});
  const statements = { get: async () => plainResult, cancel: async () => { throw new Error("404 not found"); } } as unknown as Pick<StatementLifecycle, "get" | "cancel">;
  await assert.rejects(createStatementLookup({ statements, exports }).cancel("st-missing"), /404 not found/);
});
