import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionScope } from "../src/execution-scope.ts";
import type { ExportManager } from "../src/export/manager.ts";
import type { ExportFormat, ExportState } from "../src/export/types.ts";
import type { MetadataService } from "../src/metadata.ts";
import type { MetadataCache } from "../src/metadata-cache.ts";
import type { WarehouseSelection } from "../src/warehouses.ts";
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

/** Fake services, handed to the server through `workspace`; `scope` is the execution scope of `logs`, which the fakes use to report diagnostics like the real modules. */
export const FAKE_CACHE_STATS = {
  total: { entries: 2, hits: 4, misses: 2, hitRatio: 0.6667 },
  byKind: { table: { entries: 1, hits: 3 }, listing: { entries: 1, hits: 1 } },
};
const FAKE_CACHE_ENTRY = { cachedAt: "2026-11-03T10:00:00.000Z", hits: 3, lastLoadMs: 40 };

export function fakeServices(logs: LogService, options: { cache?: boolean } = {}) {
  const scope = createExecutionScope(logs);
  const sqlRequests: ExecuteSqlRequest[] = [];
  const getStatementCalls: Array<{ statementId: string; options: unknown }> = [];
  const cancelledStatements: string[] = [];
  const describeCalls: unknown[][] = [];
  const listCalls: Array<{ refresh?: boolean }> = [];
  const statements = {
    submit: async (request: ExecuteSqlRequest) => {
      sqlRequests.push(request);
      if (request.statement.startsWith("FAIL"))
        throw new SqlError("[TABLE_OR_VIEW_NOT_FOUND] missing (SQLSTATE 42P01)");
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
  const warehouses = {
    resolve: async () => "wh1",
    list: async () => [
      { id: "wh1", name: "Serverless", state: "RUNNING", size: "2X-Small", serverless: true, isDefault: true },
    ],
  } as unknown as WarehouseSelection;
  const metadata = {
    listObjects: async (request: { catalog?: string; schema?: string; refresh?: boolean }) => {
      listCalls.push(request);
      if (request.catalog === undefined)
        return { level: "catalogs", items: [{ name: "main", comment: undefined }], truncated: false };
      if (request.schema === undefined)
        return {
          level: "schemas",
          items: [{ name: `${request.catalog}-schema`, comment: undefined }],
          truncated: false,
        };
      return { level: "tables", items: [{ name: "orders", type: "MANAGED", comment: "Orders" }], truncated: false };
    },
    describeTable: async (...args: unknown[]) => {
      describeCalls.push(args);
      return { fullName: args[0], columns: [{ name: "id", type: "bigint", nullable: false, comment: undefined }] };
    },
    searchMetadata: async () => [
      { kind: "table", catalog: "main", schema: "sales", table: "orders", column: null, comment: null },
    ],
  } as unknown as MetadataService;
  const exportCalls = {
    start: [] as Array<{ statement: ExecuteSqlRequest; format: ExportFormat; name?: string | undefined }>,
    wait: [] as Array<{ statementId: string; timeoutMs: number }>,
    cancel: [] as string[],
  };
  const exportStates = new Map<string, ExportState>();
  const exports: ExportManager = {
    start: async (request) => {
      exportCalls.start.push(request);
      scope.annotate({ checkMs: 3, warehouseId: "wh-export" });
      const state: ExportState = {
        id: "export-1",
        statementId: "st-export",
        format: request.format,
        path: `/exports/export-1.${request.format}`,
        status: "PENDING",
      };
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
  /** Knows the entries `table/main.s.t`, `listing/main.default` and the catalogs listing (empty key). */
  const cache = (options.cache === false
    ? undefined
    : {
        stats: () => FAKE_CACHE_STATS,
        entry: (kind: string, key: string) =>
          (kind === "table" && key.toLowerCase() === "main.s.t") ||
          (kind === "listing" && ["main.default", ""].includes(key.toLowerCase()))
            ? FAKE_CACHE_ENTRY
            : undefined,
      }) as unknown as MetadataCache | undefined;
  const workspace = async () => ({ warehouses, statements, metadata, exports, cache });
  return {
    workspace,
    warehouses,
    statements,
    metadata,
    exports,
    cache,
    scope,
    exportStates,
    sqlRequests,
    getStatementCalls,
    cancelledStatements,
    describeCalls,
    listCalls,
    exportCalls,
  };
}

export async function withLogs<T>(
  transport: ExecutionTransport,
  run: (context: { repository: LogRepository; logs: LogService; dir: string }) => Promise<T>,
): Promise<T> {
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
