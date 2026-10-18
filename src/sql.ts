import type { DatabricksClient } from "./client.ts";
import { DakError } from "./errors.ts";

export class SqlError extends DakError {
  constructor(message: string) {
    super("SQL", message);
  }
}

export class ReadOnlyViolationError extends DakError {
  constructor(message: string) {
    super("READ_ONLY", message);
  }
}

export interface SqlParameter {
  name: string;
  value: string | number | boolean | null;
  type?: string | undefined;
}

export interface ExecuteSqlRequest {
  statement: string;
  parameters?: SqlParameter[] | undefined;
  catalog?: string | undefined;
  schema?: string | undefined;
  rowLimit?: number | undefined;
  warehouseId?: string | undefined;
}

export interface Column {
  name: string;
  type: string;
}

export interface StatementResult {
  statementId: string;
  state: string;
  warehouseId?: string | undefined;
  columns?: Column[];
  rows?: Array<Array<string | null>>;
  rowCount?: number;
  truncated?: boolean;
  message?: string;
}

export interface WarehouseSummary {
  id: string;
  name: string;
  state: string;
  size: string | undefined;
  serverless: boolean;
  isDefault: boolean;
}

export interface SqlServiceOptions {
  maxRows: number;
  allowWrites: boolean;
  defaultWarehouseId: string | undefined;
  maxResultBytes: number;
}

interface ApiStatement {
  statement_id: string;
  status: { state: string; error?: { error_code?: string; message?: string; sql_state?: string } };
  manifest?: {
    schema?: { columns?: Array<{ name: string; type_text: string }> };
    total_row_count?: number;
    truncated?: boolean;
  };
  result?: ApiChunk;
}

interface ApiChunk {
  data_array?: Array<Array<string | null>>;
  next_chunk_internal_link?: string;
}

interface ApiWarehouse {
  id: string;
  name: string;
  state: string;
  cluster_size?: string;
  enable_serverless_compute?: boolean;
}

const DEFAULT_ROW_LIMIT = 100;
const READ_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "FROM"]);
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY)\b/i;
const WRITES_HINT = "Start the server with --allow-writes (or DAK_ALLOW_WRITES=true) to allow it.";

/** Replaces comments with spaces and literals/quoted identifiers with a placeholder. */
function stripNoise(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      output += " ";
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      output += " ";
    } else if (char === "'" || char === '"' || char === "`") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "\\" && char !== "`") {
          cursor += 2;
        } else if (sql[cursor] === char && sql[cursor + 1] === char) {
          cursor += 2;
        } else if (sql[cursor] === char) {
          break;
        } else {
          cursor++;
        }
      }
      index = cursor + 1;
      output += " x ";
    } else {
      output += char;
      index++;
    }
  }
  return output;
}

export function assertReadOnly(statement: string): void {
  const cleaned = stripNoise(statement).trim().replace(/;\s*$/, "").trim();
  if (cleaned === "") throw new ReadOnlyViolationError("Empty statement: nothing to execute.");
  if (cleaned.includes(";")) {
    throw new ReadOnlyViolationError(`Read-only mode: multiple statements are not allowed; send one statement per call. ${WRITES_HINT}`);
  }
  const keyword = /^[(\s]*([A-Za-z]+)/.exec(cleaned)?.[1]?.toUpperCase();
  if (keyword === undefined || !READ_KEYWORDS.has(keyword)) {
    throw new ReadOnlyViolationError(
      `Read-only mode: '${keyword ?? cleaned.slice(0, 20)}' statements are not allowed (allowed: ${[...READ_KEYWORDS].join(", ")}). ${WRITES_HINT}`,
    );
  }
  if (keyword === "WITH" && WRITE_KEYWORDS.test(cleaned)) {
    throw new ReadOnlyViolationError(`Read-only mode: WITH statements that modify data are not allowed. ${WRITES_HINT}`);
  }
}

function capRowsByBytes(rows: Array<Array<string | null>>, maxBytes: number): Array<Array<string | null>> {
  let size = 2;
  const kept: Array<Array<string | null>> = [];
  for (const row of rows) {
    const rowSize = JSON.stringify(row).length + (kept.length > 0 ? 1 : 0);
    if (size + rowSize > maxBytes) break;
    size += rowSize;
    kept.push(row);
  }
  return kept;
}

export function createSqlService(client: DatabricksClient, options: SqlServiceOptions) {
  let automaticWarehouse: string | undefined;

  async function fetchWarehouses(): Promise<ApiWarehouse[]> {
    const response = await client.get<{ warehouses?: ApiWarehouse[] }>("/api/2.0/sql/warehouses");
    return response.warehouses ?? [];
  }

  function chooseWarehouse(warehouses: ApiWarehouse[]): ApiWarehouse | undefined {
    return (
      warehouses.find((warehouse) => warehouse.state === "RUNNING") ??
      warehouses.find((warehouse) => warehouse.enable_serverless_compute === true) ??
      warehouses[0]
    );
  }

  async function resolveWarehouse(explicit?: string): Promise<string> {
    if (explicit !== undefined) return explicit;
    if (options.defaultWarehouseId !== undefined) return options.defaultWarehouseId;
    if (automaticWarehouse === undefined) {
      const chosen = chooseWarehouse(await fetchWarehouses());
      if (chosen === undefined) {
        throw new SqlError(
          "No SQL warehouse is accessible to this identity. Create one or get CAN USE on an existing one, or set DATABRICKS_WAREHOUSE_ID.",
        );
      }
      automaticWarehouse = chosen.id;
    }
    return automaticWarehouse;
  }

  async function listWarehouses(): Promise<WarehouseSummary[]> {
    const warehouses = await fetchWarehouses();
    const defaultId = options.defaultWarehouseId ?? chooseWarehouse(warehouses)?.id;
    return warehouses.map((warehouse) => ({
      id: warehouse.id,
      name: warehouse.name,
      state: warehouse.state,
      size: warehouse.cluster_size,
      serverless: warehouse.enable_serverless_compute === true,
      isDefault: warehouse.id === defaultId,
    }));
  }

  async function shape(statement: ApiStatement, rowLimit: number, warehouseId: string | undefined): Promise<StatementResult> {
    const { state } = statement.status;
    const base = { statementId: statement.statement_id, state, ...(warehouseId === undefined ? {} : { warehouseId }) };
    if (state === "FAILED") {
      const error = statement.status.error ?? {};
      const sqlState = error.sql_state === undefined ? "" : ` (SQLSTATE ${error.sql_state})`;
      throw new SqlError(`[${error.error_code ?? "FAILED"}] ${error.message ?? "Statement failed"}${sqlState}`);
    }
    if (state === "PENDING" || state === "RUNNING") {
      return {
        ...base,
        message: `Statement is still ${state}. Call get_statement with statement_id '${statement.statement_id}' to fetch the result, or cancel_statement to stop it.`,
      };
    }
    if (state !== "SUCCEEDED") {
      return { ...base, message: `Statement is ${state}; no result is available.` };
    }

    const rows = [...(statement.result?.data_array ?? [])];
    let nextLink = statement.result?.next_chunk_internal_link;
    while (rows.length < rowLimit && nextLink !== undefined) {
      const chunk = await client.get<ApiChunk>(nextLink);
      rows.push(...(chunk.data_array ?? []));
      nextLink = chunk.next_chunk_internal_link;
    }
    const limited = rows.slice(0, rowLimit);
    const capped = capRowsByBytes(limited, options.maxResultBytes);
    const totalRows = statement.manifest?.total_row_count ?? rows.length;
    return {
      ...base,
      columns: (statement.manifest?.schema?.columns ?? []).map((column) => ({ name: column.name, type: column.type_text })),
      rows: capped,
      rowCount: capped.length,
      truncated: statement.manifest?.truncated === true || capped.length < totalRows,
    };
  }

  async function executeSql(request: ExecuteSqlRequest): Promise<StatementResult> {
    if (!options.allowWrites) assertReadOnly(request.statement);
    const warehouseId = await resolveWarehouse(request.warehouseId);
    const rowLimit = Math.min(request.rowLimit ?? DEFAULT_ROW_LIMIT, options.maxRows);
    const body = {
      statement: request.statement,
      warehouse_id: warehouseId,
      ...(request.catalog === undefined ? {} : { catalog: request.catalog }),
      ...(request.schema === undefined ? {} : { schema: request.schema }),
      ...(request.parameters === undefined || request.parameters.length === 0
        ? {}
        : {
            parameters: request.parameters.map((parameter) => ({
              name: parameter.name,
              value: parameter.value === null ? null : String(parameter.value),
              ...(parameter.type === undefined ? {} : { type: parameter.type }),
            })),
          }),
      row_limit: rowLimit,
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    };
    const statement = await client.post<ApiStatement>("/api/2.0/sql/statements", body);
    return shape(statement, rowLimit, warehouseId);
  }

  async function getStatement(statementId: string, rowLimit = DEFAULT_ROW_LIMIT): Promise<StatementResult> {
    const statement = await client.get<ApiStatement>(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}`);
    return shape(statement, Math.min(rowLimit, options.maxRows), undefined);
  }

  async function cancelStatement(statementId: string): Promise<void> {
    await client.post(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`);
  }

  return { executeSql, getStatement, cancelStatement, resolveWarehouse, listWarehouses };
}

export type SqlService = ReturnType<typeof createSqlService>;
