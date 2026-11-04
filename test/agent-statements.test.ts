import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabricksClient } from "../src/client.ts";
import { createExportManager, type ExportManager } from "../src/export/manager.ts";
import type { ExportState } from "../src/export/types.ts";
import { createAgentStatements } from "../src/agent-statements.ts";
import {
  createStatementLifecycle,
  ReadOnlyViolationError,
  type ExecuteSqlRequest,
  type StatementLifecycle,
  type StatementResult,
} from "../src/statements.ts";

const plainResult: StatementResult = {
  statementId: "st-plain",
  state: "SUCCEEDED",
  columns: [{ name: "x", type: "INT" }],
  rows: [["1"]],
  rowCount: 1,
  truncated: false,
};

function exportState(status: ExportState["status"]): ExportState {
  return { id: "export-1", statementId: "st-export", format: "csv", path: "/exports/export-1.csv", status };
}

/** Fakes of the two modules the agent statements compose; calls are recorded, `waitResult` is what waiting for an export returns. */
function fakes(exportsByStatement: Record<string, ExportState>, waitResult?: ExportState) {
  const calls = {
    submit: [] as ExecuteSqlRequest[],
    start: [] as Array<{ statement: ExecuteSqlRequest; format: string; name?: string }>,
    get: [] as Array<{ statementId: string; options: unknown }>,
    cancelStatement: [] as string[],
    wait: [] as Array<{ statementId: string; timeoutMs: number }>,
    cancelExport: [] as string[],
  };
  const statements = {
    submit: async (request: ExecuteSqlRequest) => {
      calls.submit.push(request);
      return plainResult;
    },
    get: async (statementId: string, options?: unknown) => {
      calls.get.push({ statementId, options });
      return { ...plainResult, statementId };
    },
    cancel: async (statementId: string) => {
      calls.cancelStatement.push(statementId);
    },
  } as unknown as Pick<StatementLifecycle, "submit" | "get" | "cancel">;
  const exports = {
    start: async (request: { statement: ExecuteSqlRequest; format: string; name?: string }) => {
      calls.start.push(request);
      return { ...exportState("PENDING"), statementId: "st-started", format: request.format };
    },
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
  } as unknown as Pick<ExportManager, "start" | "get" | "wait" | "cancel">;
  return { statements, exports, agentStatements: createAgentStatements({ statements, exports }), calls };
}

test("get answers a running export with its state and does not wait without a wait time", async () => {
  const { agentStatements, calls } = fakes({ "st-export": exportState("DOWNLOADING") });
  assert.deepEqual(await agentStatements.get("st-export", {}), {
    statementId: "st-export",
    export: exportState("DOWNLOADING"),
  });
  assert.deepEqual(await agentStatements.get("st-export", { waitSeconds: 0 }), {
    statementId: "st-export",
    export: exportState("DOWNLOADING"),
  });
  assert.deepEqual(calls.wait, []);
  assert.deepEqual(calls.get, []);
});

test("get waits for an export up to the wait time and returns its state at that moment", async () => {
  const { agentStatements, calls } = fakes({ "st-export": exportState("DOWNLOADING") }, exportState("SUCCEEDED"));
  assert.deepEqual(await agentStatements.get("st-export", { waitSeconds: 3 }), {
    statementId: "st-export",
    export: exportState("SUCCEEDED"),
  });
  assert.deepEqual(calls.wait, [{ statementId: "st-export", timeoutMs: 3000 }]);
  assert.deepEqual(calls.get, []);
});

test("get answers a finished export with its final state", async () => {
  const { agentStatements } = fakes({ "st-export": exportState("SUCCEEDED") });
  assert.deepEqual(await agentStatements.get("st-export", {}), {
    statementId: "st-export",
    export: exportState("SUCCEEDED"),
  });
});

test("get forwards a plain or unknown statement id and its wait time to the statement lifecycle", async () => {
  const { agentStatements, calls } = fakes({ "st-export": exportState("PENDING") });
  assert.deepEqual(await agentStatements.get("st-other", { waitSeconds: 2 }), {
    ...plainResult,
    statementId: "st-other",
  });
  assert.deepEqual(await agentStatements.get("st-other", {}), { ...plainResult, statementId: "st-other" });
  assert.deepEqual(calls.get, [
    { statementId: "st-other", options: { waitSeconds: 2 } },
    { statementId: "st-other", options: { waitSeconds: undefined } },
  ]);
  assert.deepEqual(calls.wait, []);
});

test("cancel stops a running export through the export manager only", async () => {
  const { agentStatements, calls } = fakes({ "st-export": exportState("DOWNLOADING") });
  assert.deepEqual(await agentStatements.cancel("st-export"), { statementId: "st-export", cancelled: true });
  assert.deepEqual(calls.cancelExport, ["st-export"]);
  // The export manager cancels the Databricks statement of an export itself.
  assert.deepEqual(calls.cancelStatement, []);
});

test("cancel does not report a finished export as cancelled and returns its state", async () => {
  const { agentStatements, calls } = fakes({ "st-export": exportState("SUCCEEDED") });
  assert.deepEqual(await agentStatements.cancel("st-export"), {
    statementId: "st-export",
    cancelled: false,
    export: exportState("SUCCEEDED"),
  });
  assert.deepEqual(calls.cancelStatement, []);
});

test("cancel sends a plain or unknown statement id to the statement lifecycle", async () => {
  const { agentStatements, calls } = fakes({ "st-export": exportState("PENDING") });
  assert.deepEqual(await agentStatements.cancel("st-plain"), { statementId: "st-plain", cancelled: true });
  assert.deepEqual(calls.cancelStatement, ["st-plain"]);
  assert.deepEqual(calls.cancelExport, []);
});

test("cancel lets the error of the statement lifecycle reach the caller", async () => {
  const { exports } = fakes({});
  const statements = {
    get: async () => plainResult,
    cancel: async () => {
      throw new Error("404 not found");
    },
  } as unknown as Pick<StatementLifecycle, "submit" | "get" | "cancel">;
  await assert.rejects(createAgentStatements({ statements, exports }).cancel("st-missing"), /404 not found/);
});

const request: ExecuteSqlRequest = {
  statement: "SELECT :n",
  parameters: [{ name: "n", value: 1, type: "INT" }],
  catalog: "main",
  schema: "sales",
  rowLimit: 5,
  warehouseId: "wh-1",
};

test("execute without an export runs the statement inline and gives its result", async () => {
  const { agentStatements, calls } = fakes({});
  assert.deepEqual(await agentStatements.execute(request), plainResult);
  assert.deepEqual(calls.submit, [request]);
  assert.deepEqual(calls.start, []);
});

test("execute with an export starts it without a row limit and answers PENDING with the export descriptor", async () => {
  const { agentStatements, calls } = fakes({});
  const answer = await agentStatements.execute({ ...request, export: { format: "parquet", name: "orders" } });
  assert.deepEqual(answer, {
    statementId: "st-started",
    state: "PENDING",
    export: { ...exportState("PENDING"), statementId: "st-started", format: "parquet" },
  });
  assert.deepEqual(calls.start, [
    {
      statement: {
        statement: "SELECT :n",
        parameters: [{ name: "n", value: 1, type: "INT" }],
        catalog: "main",
        schema: "sales",
        warehouseId: "wh-1",
      },
      format: "parquet",
      name: "orders",
    },
  ]);
  assert.deepEqual(calls.submit, []);
});

test("execute with an export and no name lets the export manager choose it", async () => {
  const { agentStatements, calls } = fakes({});
  await agentStatements.execute({ statement: "SELECT 1", export: { format: "csv" } });
  assert.deepEqual(calls.start, [{ statement: { statement: "SELECT 1" }, format: "csv", name: undefined }]);
});

test("execute puts the statement through the read-only policy on both branches before anything is submitted", async () => {
  const checks: string[] = [];
  const client: DatabricksClient = {
    host: "https://ws",
    get: async () => {
      throw new Error("unexpected GET");
    },
    post: async <T>(_path: string, body?: unknown) => {
      checks.push((body as { statement: string }).statement);
      return {
        statement_id: "ck",
        status: {
          state: "FAILED",
          error: { error_code: "BAD_REQUEST", message: "[PARSE_SYNTAX_ERROR] Syntax error at or near 'TABLE'." },
        },
      } as T;
    },
  };
  const lifecycle = createStatementLifecycle(client, {
    maxRows: 100,
    allowWrites: false,
    maxResultBytes: 100_000,
    resolveWarehouse: async () => "wh-1",
  });
  const dir = await mkdtemp(join(tmpdir(), "dak-agent-statements-"));
  try {
    const exports = createExportManager({
      statements: lifecycle,
      fetch: async () => {
        throw new Error("unexpected download");
      },
      dir,
      scope: {
        run: async () => {
          throw new Error("unexpected export job");
        },
      },
      sleep: async () => undefined,
    });
    const agentStatements = createAgentStatements({ statements: lifecycle, exports });
    await assert.rejects(agentStatements.execute({ statement: "DROP TABLE t" }), ReadOnlyViolationError);
    await assert.rejects(
      agentStatements.execute({ statement: "DROP TABLE t", export: { format: "csv" } }),
      ReadOnlyViolationError,
    );
    // Each branch sent only its DESCRIBE QUERY check: the write itself never reached Databricks.
    assert.deepEqual(checks, ["DESCRIBE QUERY DROP TABLE t", "DESCRIBE QUERY DROP TABLE t"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
