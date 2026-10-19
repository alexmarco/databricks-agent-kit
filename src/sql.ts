import type { DatabricksClient } from "./client.ts";
import { DakError } from "./errors.ts";
import type { ExportFormat } from "./export/types.ts";

/** Statement that Databricks failed to plan or run; the message keeps the error class and SQLSTATE. */
export class SqlError extends DakError {
  constructor(message: string) {
    super("SQL", message);
  }
}

/** Statement rejected in read-only mode because it is not a query, SHOW, DESCRIBE or EXPLAIN. */
export class ReadOnlyViolationError extends DakError {
  constructor(message: string) {
    super("READ_ONLY", message);
  }
}

/** Value for a `:name` parameter marker; Databricks casts it to `type` (default `STRING`). */
export interface SqlParameter {
  name: string;
  value: string | number | boolean | null;
  type?: string | undefined;
}

/** One statement to run on a SQL warehouse. */
export interface ExecuteSqlRequest {
  statement: string;
  parameters?: SqlParameter[] | undefined;
  /** Default catalog, like `USE CATALOG`. */
  catalog?: string | undefined;
  /** Default schema, like `USE SCHEMA`. */
  schema?: string | undefined;
  /** Rows to return; defaults to 100 and is capped by `maxRows`. */
  rowLimit?: number | undefined;
  /** Warehouse to use instead of the default one. */
  warehouseId?: string | undefined;
}

/** Result column name and SQL type. */
export interface Column {
  name: string;
  type: string;
}

/** Bounded result of a statement, or its state and id while it is still running. */
export interface StatementResult {
  statementId: string;
  /** Databricks state: `SUCCEEDED`, `PENDING`, `RUNNING`, `CANCELED` or `CLOSED`. */
  state: string;
  warehouseId?: string | undefined;
  columns?: Column[];
  /** Rows as strings (JSON_ARRAY format), null for SQL NULL. */
  rows?: Array<Array<string | null>>;
  rowCount?: number;
  /** True when rows were cut by the row or size limit; the agent should aggregate or filter. */
  truncated?: boolean;
  /** Next step for statements that are not finished. */
  message?: string;
}

/** SQL warehouse as listed to the agent. */
export interface WarehouseSummary {
  id: string;
  name: string;
  state: string;
  size: string | undefined;
  serverless: boolean;
  isDefault: boolean;
}

/** Timings that {@link SqlService.executeSql} reports to its caller. */
export interface ExecutionDiagnostics {
  /** Milliseconds spent in the read-only check; unset when no `DESCRIBE QUERY` call was needed. */
  checkMs?: number;
  /** Warehouse an export was submitted to; set by {@link SqlService.submitExport}. */
  warehouseId?: string;
}

/** Why the automatic warehouse choice picked a warehouse. */
export interface WarehouseChosenEvent {
  warehouseId: string;
  name: string;
  reason: "running" | "serverless" | "first";
}

/** Limits and defaults of the SQL service. */
export interface SqlServiceOptions {
  /** Upper bound for any requested row limit. */
  maxRows: number;
  /** When false, agent statements other than SHOW, DESCRIBE and EXPLAIN are checked with DESCRIBE QUERY before they run. */
  allowWrites: boolean;
  /** Configured warehouse; otherwise a running one, then a serverless one, then the first is used. */
  defaultWarehouseId: string | undefined;
  /** Maximum size of the returned rows, applied by Databricks (`byte_limit`) and again locally. */
  maxResultBytes: number;
  /** Size limit of an export, sent as `byte_limit`; defaults to 10 GiB. */
  maxExportBytes?: number;
  /** Waits between polls of {@link SqlService.getStatement}; replaceable in tests. */
  sleep?(ms: number): Promise<void>;
  /** Clock in milliseconds; replaceable in tests. */
  now?(): number;
  /** Called once when a warehouse is chosen automatically (none configured, none passed). */
  onWarehouseChosen?(event: WarehouseChosenEvent): void;
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

/** Request body of the Statement Execution API. */
interface StatementBody {
  statement: string;
  warehouse_id: string;
  catalog?: string;
  schema?: string;
  parameters?: Array<{ name: string; value: string | null; type?: string }>;
  row_limit?: number;
  byte_limit: number;
  wait_timeout: string;
  on_wait_timeout: "CONTINUE" | "CANCEL";
  disposition: "INLINE" | "EXTERNAL_LINKS";
  format: "JSON_ARRAY" | "CSV" | "ARROW_STREAM";
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
const STATEMENTS_PATH = "/api/2.0/sql/statements";
const WRITES_HINT = "Start the server with --allow-writes (or DAK_ALLOW_WRITES=true) to allow it.";
/**
 * Start of a read command: SHOW, DESCRIBE, DESC or EXPLAIN as a whole word, after [ \t\r\n] only, and not followed by
 * a `:` (which would make it a SQL-scripting label such as `SHOW: BEGIN ... END`).
 */
const READ_COMMAND = /^[ \t\r\n]*(?:SHOW|DESCRIBE|DESC|EXPLAIN)(?![ \t\r\n]*:)(?:[ \t\r\n]|$)/i;
/** A `;` before the last non-whitespace character: several statements, a script or a literal holding `;`. */
const INNER_SEMICOLON = /;[^]*[^ \t\r\n]/;
const CHECK_ROW_LIMIT = 100;
const CHECK_BYTE_LIMIT = 10_000_000;
const DEFAULT_EXPORT_BYTE_LIMIT = 10 * 1024 ** 3;
const MAX_WAIT_SECONDS = 30;
const EXPORT_RESULT_FORMAT = { csv: "CSV", parquet: "ARROW_STREAM", sqlite: "JSON_ARRAY" } as const;

/**
 * True when the statement is a plain SHOW, DESCRIBE, DESC or EXPLAIN command that can run without a check: it starts,
 * after spaces, tabs and line breaks only, with one of those words as a whole word not followed by a `:`, and holds no
 * `;` except at the end.
 * Comments are deliberately not skipped: a scanner that disagrees with the Databricks lexer could let a write through.
 */
export function isReadCommand(statement: string): boolean {
  return READ_COMMAND.test(statement) && !INNER_SEMICOLON.test(statement);
}

/** Builds the error of a FAILED statement, keeping the Databricks error class and SQLSTATE. */
function statementError(status: ApiStatement["status"]): SqlError {
  const error = status.error ?? {};
  const sqlState = error.sql_state === undefined ? "" : ` (SQLSTATE ${error.sql_state})`;
  return new SqlError(`[${error.error_code ?? "FAILED"}] ${error.message ?? "Statement failed"}${sqlState}`);
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

/** Creates the SQL service: warehouse selection, statement execution with bounded results and the read-only check. */
export function createSqlService(client: DatabricksClient, options: SqlServiceOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let automaticWarehouse: string | undefined;

  async function fetchWarehouses(): Promise<ApiWarehouse[]> {
    const response = await client.get<{ warehouses?: ApiWarehouse[] }>("/api/2.0/sql/warehouses");
    return response.warehouses ?? [];
  }

  function chooseWarehouse(warehouses: ApiWarehouse[]): { warehouse: ApiWarehouse; reason: WarehouseChosenEvent["reason"] } | undefined {
    const running = warehouses.find((warehouse) => warehouse.state === "RUNNING");
    if (running !== undefined) return { warehouse: running, reason: "running" };
    const serverless = warehouses.find((warehouse) => warehouse.enable_serverless_compute === true);
    if (serverless !== undefined) return { warehouse: serverless, reason: "serverless" };
    const first = warehouses[0];
    return first === undefined ? undefined : { warehouse: first, reason: "first" };
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
      automaticWarehouse = chosen.warehouse.id;
      try {
        options.onWarehouseChosen?.({ warehouseId: chosen.warehouse.id, name: chosen.warehouse.name, reason: chosen.reason });
      } catch {
        // The callback only observes the choice; its failure must not fail the request.
      }
    }
    return automaticWarehouse;
  }

  async function listWarehouses(): Promise<WarehouseSummary[]> {
    const warehouses = await fetchWarehouses();
    const defaultId = options.defaultWarehouseId ?? chooseWarehouse(warehouses)?.warehouse.id;
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
    if (state === "FAILED") throw statementError(statement.status);
    if (state === "PENDING" || state === "RUNNING") {
      return {
        ...base,
        message: `Statement is still ${state}. Call get_statement with statement_id '${statement.statement_id}' to fetch the result, or get_statement with cancel: true to stop it.`,
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

  async function statementBody(request: ExecuteSqlRequest): Promise<StatementBody> {
    return {
      statement: request.statement,
      warehouse_id: await resolveWarehouse(request.warehouseId),
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
      row_limit: Math.min(request.rowLimit ?? DEFAULT_ROW_LIMIT, options.maxRows),
      byte_limit: options.maxResultBytes,
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    };
  }

  async function submit(body: StatementBody): Promise<StatementResult> {
    return shape(await client.post<ApiStatement>(STATEMENTS_PATH, body), body.row_limit ?? DEFAULT_ROW_LIMIT, body.warehouse_id);
  }

  /**
   * Rejects the statement unless it only reads. A plain leading SHOW, DESCRIBE, DESC or EXPLAIN passes without a call
   * (see {@link isReadCommand}); the fast path has no comment handling because a scanner that disagrees with the
   * Databricks lexer could let a write through. A `;` before the end is rejected without any call, so the check itself
   * never submits several statements. Anything else is analysed by Databricks itself with `DESCRIBE QUERY`, which only
   * parses queries. `diagnostics.checkMs` is set only when that call ran.
   */
  async function assertReadOnly(body: StatementBody, diagnostics?: ExecutionDiagnostics): Promise<void> {
    if (INNER_SEMICOLON.test(body.statement)) {
      throw new ReadOnlyViolationError(
        `Read-only mode: the statement has several statements or a ';' inside a literal, and read-only mode cannot tell them apart. Pass literals that contain ';' as :name parameters. ${WRITES_HINT}`,
      );
    }
    if (isReadCommand(body.statement)) return;
    const startedAt = now();
    const check = await client.post<ApiStatement>(STATEMENTS_PATH, {
      ...body,
      statement: `DESCRIBE QUERY ${body.statement}`,
      row_limit: CHECK_ROW_LIMIT,
      byte_limit: CHECK_BYTE_LIMIT,
      wait_timeout: "50s",
      on_wait_timeout: "CANCEL",
    });
    if (diagnostics !== undefined) diagnostics.checkMs = now() - startedAt;
    const { state } = check.status;
    if (state === "FAILED") {
      const error = statementError(check.status);
      if (check.status.error?.message?.includes("PARSE_SYNTAX_ERROR")) {
        throw new ReadOnlyViolationError(`Read-only mode: the statement is not a query, SHOW, DESCRIBE or EXPLAIN. ${error.message} ${WRITES_HINT} If the statement starts with a comment, remove it.`);
      }
      throw error;
    }
    if (state !== "SUCCEEDED") {
      throw new SqlError(`Read-only check did not finish (${state}); the warehouse may still be starting, retry in a moment.`);
    }
  }

  /** Runs SQL written by this server (metadata tools, doctor probes) without the read-only check. */
  async function runStatement(request: ExecuteSqlRequest): Promise<StatementResult> {
    return submit(await statementBody(request));
  }

  /**
   * Runs server-written SQL like {@link runStatement}, but cancels a statement that is still running after the wait.
   * The cancel is best effort: its failure must not hide the "did not finish" error.
   */
  async function runQuery(request: ExecuteSqlRequest): Promise<StatementResult> {
    const result = await runStatement(request);
    if (result.state === "PENDING" || result.state === "RUNNING") {
      await cancelStatement(result.statementId).catch(() => undefined);
      throw new SqlError(`Statement did not finish in time (${result.state}); the warehouse may be starting, retry in a moment.`);
    }
    return result;
  }

  /** Runs one statement from the agent; in read-only mode it is checked with {@link assertReadOnly} first. */
  async function executeSql(request: ExecuteSqlRequest, diagnostics?: ExecutionDiagnostics): Promise<StatementResult> {
    const body = await statementBody(request);
    if (!options.allowWrites) await assertReadOnly(body, diagnostics);
    return submit(body);
  }

  /**
   * Starts an export of the full result as EXTERNAL_LINKS and returns without waiting for it. The read-only check is the
   * same as in {@link executeSql}, so an export cannot run a statement that `execute_sql` would reject.
   */
  async function submitExport(request: ExecuteSqlRequest, format: ExportFormat, diagnostics?: ExecutionDiagnostics): Promise<{ statementId: string; warehouseId: string }> {
    const { row_limit: _rowLimit, ...inlineBody } = await statementBody(request);
    if (!options.allowWrites) await assertReadOnly(inlineBody, diagnostics);
    const response = await client.post<ApiStatement>(STATEMENTS_PATH, {
      ...inlineBody,
      byte_limit: options.maxExportBytes ?? DEFAULT_EXPORT_BYTE_LIMIT,
      wait_timeout: "0s",
      on_wait_timeout: "CONTINUE",
      disposition: "EXTERNAL_LINKS",
      format: EXPORT_RESULT_FORMAT[format],
    } satisfies StatementBody);
    if (response.status.state === "FAILED") throw statementError(response.status);
    if (diagnostics !== undefined) diagnostics.warehouseId = inlineBody.warehouse_id;
    return { statementId: response.statement_id, warehouseId: inlineBody.warehouse_id };
  }

  /**
   * Fetches a statement. With `waitSeconds` (0 to 30) it polls with waits of 1 s, 2 s, 3 s... until the statement is
   * no longer PENDING or RUNNING or the time is spent; a statement still running is returned as such.
   */
  async function getStatement(statementId: string, getOptions: { rowLimit?: number; waitSeconds?: number } = {}): Promise<StatementResult> {
    const path = `${STATEMENTS_PATH}/${encodeURIComponent(statementId)}`;
    const requestedSeconds = getOptions.waitSeconds ?? 0;
    const waitSeconds = Number.isFinite(requestedSeconds) ? Math.min(Math.max(requestedSeconds, 0), MAX_WAIT_SECONDS) : 0;
    const deadline = now() + waitSeconds * 1000;
    let statement = await client.get<ApiStatement>(path);
    for (let attempt = 1; statement.status.state === "PENDING" || statement.status.state === "RUNNING"; attempt++) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(attempt * 1000, remainingMs));
      statement = await client.get<ApiStatement>(path);
    }
    return shape(statement, Math.min(getOptions.rowLimit ?? options.maxRows, options.maxRows), undefined);
  }

  async function cancelStatement(statementId: string): Promise<void> {
    await client.post(`${STATEMENTS_PATH}/${encodeURIComponent(statementId)}/cancel`);
  }

  return { executeSql, runStatement, runQuery, submitExport, getStatement, cancelStatement, resolveWarehouse, listWarehouses };
}

/** Methods returned by {@link createSqlService}. */
export type SqlService = ReturnType<typeof createSqlService>;
