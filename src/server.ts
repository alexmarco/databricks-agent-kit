import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import { LOG_LEVELS } from "./config.ts";
import { DakError } from "./errors.ts";
import type { LogRepository } from "./logging/repository.ts";
import type { LogService } from "./logging/service.ts";
import type { MetadataService } from "./metadata.ts";
import type { SqlService, StatementResult } from "./sql.ts";

export const TOOL_NAMES = [
  "list_warehouses",
  "list_catalogs",
  "list_schemas",
  "list_tables",
  "describe_table",
  "search_metadata",
  "sample_table",
  "execute_sql",
  "get_statement",
  "cancel_statement",
  "table_lineage",
  "search_logs",
] as const;

export interface ServerDependencies {
  sql: SqlService;
  metadata: MetadataService;
  logs: LogService;
  repository: LogRepository;
  version: string;
  allowWrites?: boolean;
}

const DAY_MS = 86_400_000;
const RECENT_LIMIT = 50;

const INSTRUCTIONS = [
  "Databricks SQL execution and Unity Catalog metadata through public workspace APIs.",
  "Use these tools instead of the Databricks CLI (`databricks experimental aitools tools query|discover-schema|statement`) or Genie for SQL and metadata work.",
  "To answer a data question: search_metadata -> describe_table (columns, comments, keys, tags) -> sample_table -> execute_sql.",
  "Results are row- and size-limited and report `truncated`; aggregate in SQL instead of fetching raw rows.",
  "Long statements return a statement_id: poll get_statement or stop them with cancel_statement.",
  "Operational logs: resources resource://logs/* and the search_logs tool.",
].join(" ");

const fullName = z.string().describe("Three-part name: catalog.schema.table");

function errorMessage(error: unknown): string {
  if (error instanceof DakError) return error.message;
  if (error instanceof Error) return `Unexpected error: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}

function summarize(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return { count: result.length };
  const statement = result as Partial<StatementResult> | undefined;
  if (statement?.statementId !== undefined) {
    return { statementId: statement.statementId, state: statement.state, rowCount: statement.rowCount, truncated: statement.truncated };
  }
  return {};
}

export function createMcpServer(deps: ServerDependencies): McpServer {
  const { sql, metadata, logs, repository } = deps;
  const server = new McpServer({ name: "databricks-agent-kit", version: deps.version }, { instructions: INSTRUCTIONS });

  function tool<Schema extends z.ZodObject>(name: (typeof TOOL_NAMES)[number], description: string, inputSchema: Schema, run: (args: z.output<Schema>) => Promise<unknown>) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: name !== "execute_sql" || deps.allowWrites !== true } }, (async (args: z.output<Schema>) => {
      const execution = logs.startExecution({ toolName: name });
      const startedAt = Date.now();
      execution.info("Tool call started", args as Record<string, unknown>);
      try {
        const result = await run(args);
        execution.info("Tool call completed", { durationMs: Date.now() - startedAt, ...summarize(result) });
        execution.complete();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        execution.fail(error);
        return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] };
      }
    }) as never);
  }

  function resource(name: string, uri: string | ResourceTemplate, description: string, read: (url: URL, variables: Record<string, string | string[]>) => unknown) {
    const handler = async (url: URL, variables: Record<string, string | string[]> = {}) => {
      const execution = logs.startExecution({ resourceUri: url.href });
      try {
        logs.flush();
        const payload = read(url, variables);
        execution.complete();
        return { contents: [{ uri: url.href, mimeType: "application/json", text: JSON.stringify(payload) }] };
      } catch (error) {
        execution.fail(error);
        throw error;
      }
    };
    const config = { title: name, description, mimeType: "application/json" };
    if (typeof uri === "string") server.registerResource(name, uri, config, (url) => handler(url));
    else server.registerResource(name, uri, config, (url, variables) => handler(url, variables as Record<string, string | string[]>));
  }

  tool("list_warehouses", "List SQL warehouses visible to this identity and which one is used by default.", z.object({}), () => sql.listWarehouses());
  tool("list_catalogs", "List Unity Catalog catalogs.", z.object({}), () => metadata.listCatalogs());
  tool("list_schemas", "List schemas in a catalog.", z.object({ catalog: z.string() }), (args) => metadata.listSchemas(args.catalog));
  tool(
    "list_tables",
    "List tables and views in a schema, optionally filtered by a name pattern (substring or glob with * and ?).",
    z.object({ catalog: z.string(), schema: z.string(), name_pattern: z.string().optional() }),
    (args) => metadata.listTables(args.catalog, args.schema, args.name_pattern),
  );
  tool(
    "describe_table",
    "Describe a table: type, owner, comment, columns with types/comments, primary and foreign keys, clustering, partitioning and tags.",
    z.object({ full_name: fullName }),
    (args) => metadata.describeTable(args.full_name),
  );
  tool(
    "search_metadata",
    "Find tables and columns whose name or comment contains the query (information_schema). Use it to locate data before writing SQL.",
    z.object({ query: z.string().min(1), catalog: z.string().optional(), limit: z.number().int().positive().max(200).optional() }),
    (args) => metadata.searchMetadata({ query: args.query, catalog: args.catalog, limit: args.limit }),
  );
  tool(
    "sample_table",
    "Return the first rows of a table (default 10, max 100).",
    z.object({ full_name: fullName, limit: z.number().int().positive().max(100).optional() }),
    (args) => metadata.sampleTable(args.full_name, args.limit),
  );
  tool(
    "execute_sql",
    `Run one Databricks SQL statement on a SQL warehouse${deps.allowWrites === true ? " (writes enabled)" : " (read-only: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, VALUES, FROM)"}. Use :name parameters instead of string interpolation. Prefer this over the Databricks CLI.`,
    z.object({
      statement: z.string().min(1),
      parameters: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]), type: z.string().optional() })).optional(),
      catalog: z.string().optional(),
      schema: z.string().optional(),
      row_limit: z.number().int().positive().optional(),
      warehouse_id: z.string().optional(),
    }),
    (args) =>
      sql.executeSql({
        statement: args.statement,
        parameters: args.parameters,
        catalog: args.catalog,
        schema: args.schema,
        rowLimit: args.row_limit,
        warehouseId: args.warehouse_id,
      }),
  );
  tool("get_statement", "Fetch the state and result of a statement started by execute_sql.", z.object({ statement_id: z.string() }), (args) => sql.getStatement(args.statement_id));
  tool("cancel_statement", "Cancel a running statement.", z.object({ statement_id: z.string() }), async (args) => {
    await sql.cancelStatement(args.statement_id);
    return { statementId: args.statement_id, cancelled: true };
  });
  tool(
    "table_lineage",
    "Upstream and downstream tables from Unity Catalog lineage system tables (reports clearly when unavailable).",
    z.object({ full_name: fullName, direction: z.enum(["upstream", "downstream", "both"]).optional() }),
    (args) => metadata.tableLineage(args.full_name, args.direction),
  );
  tool(
    "search_logs",
    "Search this server's operational logs (SQLite) by level, text, execution id and ISO time range.",
    z.object({
      level: z.enum(LOG_LEVELS).optional(),
      text: z.string().optional(),
      executionId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    async (args) => {
      logs.flush();
      return repository.searchLogs(args);
    },
  );

  resource("recent-errors", "resource://logs/errors/recent", "Most recent error and fatal log entries.", () => ({
    generatedAt: new Date().toISOString(),
    errors: repository.recentErrors(RECENT_LIMIT),
  }));
  resource("recent-executions", "resource://logs/executions/recent", "Most recent tool calls and resource reads.", () => ({
    executions: repository.recentExecutions(RECENT_LIMIT),
  }));
  resource("stats", "resource://logs/stats", "Execution, error and warning counts for the last 24 hours.", () => ({
    last24h: repository.stats(Date.now() - DAY_MS),
  }));
  resource(
    "execution-detail",
    new ResourceTemplate("resource://logs/execution/{executionId}", { list: undefined }),
    "One execution with its full ordered log trail.",
    (_url, variables) => {
      const executionId = String(variables.executionId);
      const detail = repository.executionDetail(executionId);
      if (detail === undefined) throw new DakError("NOT_FOUND", `Execution '${executionId}' not found (it may be older than the 90-day retention).`);
      return detail;
    },
  );

  return server;
}
