import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportManager } from "../src/export/manager.ts";
import type { ExportFormat, ExportState } from "../src/export/types.ts";
import type { MetadataService } from "../src/metadata.ts";
import type { SqlService } from "../src/sql.ts";
import type { ExecuteSqlRequest, StatementLifecycle, StatementResult } from "../src/statements.ts";
import { SqlError } from "../src/statements.ts";
import { openLogRepository, type LogRepository } from "../src/logging/repository.ts";
import { createLogService, type LogService } from "../src/logging/service.ts";
import type { ExecutionTransport } from "../src/logging/repository.ts";

export const okResult: StatementResult = {
  statementId: "st1",
  state: "SUCCEEDED",
  warehouseId: "wh1",
  columns: [{ name: "result", type: "INT" }],
  rows: [["1"]],
  rowCount: 1,
  truncated: false,
};

export function fakeServices() {
  const sqlRequests: ExecuteSqlRequest[] = [];
  const getStatementCalls: Array<{ statementId: string; options: unknown }> = [];
  const cancelledStatements: string[] = [];
  const statements = {
    submit: async (request: ExecuteSqlRequest) => {
      sqlRequests.push(request);
      if (request.statement.startsWith("FAIL")) throw new SqlError("[TABLE_OR_VIEW_NOT_FOUND] missing (SQLSTATE 42P01)");
      return okResult;
    },
    get: async (statementId: string, options?: unknown) => {
      getStatementCalls.push({ statementId, options });
      return { ...okResult, statementId };
    },
    cancel: async (statementId: string) => {
      cancelledStatements.push(statementId);
    },
  } as unknown as StatementLifecycle;
  const sql = {
    runQuery: async () => okResult,
    resolveWarehouse: async () => "wh1",
    listWarehouses: async () => [{ id: "wh1", name: "Serverless", state: "RUNNING", size: "2X-Small", serverless: true, isDefault: true }],
  } as unknown as SqlService;
  const metadata = {
    listObjects: async (request: { catalog?: string; schema?: string }) => {
      if (request.catalog === undefined) return { level: "catalogs", items: [{ name: "main", comment: undefined }], truncated: false };
      if (request.schema === undefined) return { level: "schemas", items: [{ name: `${request.catalog}-schema`, comment: undefined }], truncated: false };
      return { level: "tables", items: [{ name: "orders", type: "MANAGED", comment: "Orders" }], truncated: false };
    },
    describeTable: async (fullName: string, options: { sampleRows?: number; lineage?: boolean } = {}) => ({
      fullName,
      columns: [{ name: "id", type: "bigint", nullable: false, comment: undefined }],
      ...(options.sampleRows === undefined ? {} : { sample: okResult }),
      ...(options.lineage === true ? { lineage: { upstream: [], downstream: [] } } : {}),
    }),
    searchMetadata: async () => [{ kind: "table", catalog: "main", schema: "sales", table: "orders", column: null, comment: null }],
  } as unknown as MetadataService;
  const exportCalls = {
    start: [] as Array<{ statement: ExecuteSqlRequest; format: ExportFormat; name?: string | undefined }>,
    wait: [] as Array<{ statementId: string; timeoutMs: number }>,
    cancel: [] as string[],
  };
  const exportStates = new Map<string, ExportState>();
  const exports: ExportManager = {
    start: async (request, diagnostics) => {
      exportCalls.start.push(request);
      if (diagnostics !== undefined) Object.assign(diagnostics, { checkMs: 3, warehouseId: "wh-export" });
      const state: ExportState = { id: "export-1", statementId: "st-export", format: request.format, path: `/exports/export-1.${request.format}`, status: "PENDING" };
      exportStates.set(state.statementId, state);
      return structuredClone(state);
    },
    get: async (statementId) => structuredClone(exportStates.get(statementId)),
    wait: async (statementId, timeoutMs) => {
      exportCalls.wait.push({ statementId, timeoutMs });
      return structuredClone(exportStates.get(statementId));
    },
    cancel: async (statementId) => {
      exportCalls.cancel.push(statementId);
      const state = exportStates.get(statementId);
      if (state === undefined || ["SUCCEEDED", "FAILED", "CANCELED"].includes(state.status)) return false;
      state.status = "CANCELED";
      return true;
    },
    cleanup: async () => undefined,
    close: async () => undefined,
  };
  return { sql, statements, metadata, exports, exportStates, sqlRequests, getStatementCalls, cancelledStatements, exportCalls };
}

export async function withLogs<T>(transport: ExecutionTransport, run: (context: { repository: LogRepository; logs: LogService; dir: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dak-test-"));
  const repository = await openLogRepository(join(dir, "logs.db"));
  const logs = createLogService({ repository, transport, level: "info" });
  try {
    return await run({ repository, logs, dir });
  } finally {
    logs.close();
    await rm(dir, { recursive: true, force: true });
  }
}
