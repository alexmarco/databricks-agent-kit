import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetadataService } from "../src/metadata.ts";
import type { ExecuteSqlRequest, SqlService, StatementResult } from "../src/sql.ts";
import { SqlError } from "../src/sql.ts";
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
  const sql = {
    executeSql: async (request: ExecuteSqlRequest) => {
      sqlRequests.push(request);
      if (request.statement.startsWith("FAIL")) throw new SqlError("[TABLE_OR_VIEW_NOT_FOUND] missing (SQLSTATE 42P01)");
      return okResult;
    },
    getStatement: async (statementId: string) => ({ ...okResult, statementId }),
    cancelStatement: async () => undefined,
    resolveWarehouse: async () => "wh1",
    listWarehouses: async () => [{ id: "wh1", name: "Serverless", state: "RUNNING", size: "2X-Small", serverless: true, isDefault: true }],
  } as unknown as SqlService;
  const metadata = {
    listCatalogs: async () => [{ name: "main", comment: undefined }],
    listSchemas: async (catalog: string) => [{ name: `${catalog}-schema`, comment: undefined }],
    listTables: async () => [{ name: "orders", type: "MANAGED", comment: "Orders" }],
    describeTable: async (fullName: string) => ({ fullName, columns: [{ name: "id", type: "bigint", nullable: false, comment: undefined }] }),
    searchMetadata: async () => [{ kind: "table", catalog: "main", schema: "sales", table: "orders", column: null, comment: null }],
    sampleTable: async () => okResult,
    tableLineage: async (fullName: string) => ({ table: fullName, upstream: [], downstream: [] }),
  } as unknown as MetadataService;
  return { sql, metadata, sqlRequests };
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
