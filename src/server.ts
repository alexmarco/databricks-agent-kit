import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import { DakError } from "./errors.ts";
import type { ExecutionScope } from "./execution-scope.ts";
import { describeArguments } from "./logging/arguments.ts";
import type { LogRepository } from "./logging/repository.ts";
import type { LogService } from "./logging/service.ts";
import { createStatementLookup } from "./statement-lookup.ts";
import type { Workspace } from "./workspace-session.ts";

/** Names of every tool the server registers. */
export const TOOL_NAMES = ["list_objects", "describe_table", "search_metadata", "execute_sql", "get_statement"] as const;

/** Services behind the MCP tools and resources. */
export interface ServerDependencies {
  /**
   * The Databricks modules, from the workspace session (ADR 0014). Each tool call and recorded resource read awaits it inside
   * its execution, so a failed credential resolution is the single error of that call and the next call tries again.
   */
  workspace(): Promise<Pick<Workspace, "warehouses" | "statements" | "metadata" | "exports">>;
  /** Opens the execution of each tool call, recorded resource read and export; the services annotate through it. */
  scope: ExecutionScope;
  logs: LogService;
  repository: LogRepository;
  version: string;
  allowWrites?: boolean;
}

const DAY_MS = 86_400_000;
const RECENT_LIMIT = 50;
/** Result fields copied to the final log entry of a tool call when present. */
const SUMMARY_KEYS = ["statementId", "warehouseId", "state", "rowCount", "truncated"] as const;

const INSTRUCTIONS = [
  "Databricks SQL execution and Unity Catalog metadata through public workspace APIs.",
  "Use these tools instead of the Databricks CLI (`databricks experimental aitools tools query|discover-schema|statement`) or Genie for SQL and metadata work.",
  "Tools: list_objects, describe_table, search_metadata, execute_sql, get_statement.",
  "To answer a data question: list_objects or search_metadata -> describe_table -> execute_sql.",
  "Results are row- and size-limited and report `truncated`; aggregate in SQL, or pass `export` to execute_sql to write the full result to a file.",
  "Long statements and exports return a statement_id: follow them with get_statement.",
  "Warehouses: resource://databricks/warehouses. Operational logs: resource://logs/*.",
].join(" ");

function errorMessage(error: unknown): string {
  if (error instanceof DakError) return error.message;
  if (error instanceof Error) return `Unexpected error: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}

function summarize(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return {};
  const fields = result as Record<string, unknown>;
  return Object.fromEntries(SUMMARY_KEYS.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
}

/**
 * Builds the MCP server with its tools and resources. Every tool call runs in the execution scope (ADR 0013), which writes a single entry when
 * it ends: `info` on success, or the `warn`/`error` of the error class; failures are returned to the agent as `isError` results
 * with an actionable message. Reads of the log resources open no execution, so they do not inflate the statistics they
 * report; an unexpected error while reading them is logged on the lifecycle execution.
 */
export function createMcpServer(deps: ServerDependencies): McpServer {
  const { workspace, scope, logs, repository } = deps;
  const server = new McpServer({ name: "databricks-agent-kit", version: deps.version }, { instructions: INSTRUCTIONS });

  function tool<Schema extends z.ZodObject>(
    name: (typeof TOOL_NAMES)[number],
    description: string,
    inputSchema: Schema,
    run: (args: z.output<Schema>) => Promise<unknown>,
  ) {
    const annotations =
      name === "execute_sql"
        ? { readOnlyHint: false, destructiveHint: deps.allowWrites === true }
        : name === "get_statement"
          ? { readOnlyHint: false, destructiveHint: false }
          : { readOnlyHint: true };
    // The JSON Schema `$schema` URI tells the agent nothing and costs about 60 characters per tool in every session.
    server.registerTool(name, { description, inputSchema: inputSchema.meta({ $schema: undefined }), annotations }, (async (args: z.output<Schema>) => {
      try {
        // The reply is serialized inside the scope, so a result that cannot be serialized fails the execution.
        const reply = await scope.run(
          { toolName: name },
          async () => {
            const result = await run(args);
            return { result, text: JSON.stringify(result) };
          },
          { message: "Tool call completed", arguments: describeArguments(args as Record<string, unknown>), summarize: ({ result }) => summarize(result) },
        );
        return { content: [{ type: "text" as const, text: reply.text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: errorMessage(error) }] };
      }
    }) as never);
  }

  /** Registers a JSON resource; with `record` each read is an execution, otherwise it only flushes the log queue. */
  function resource(
    name: string,
    uri: string | ResourceTemplate,
    description: string,
    record: boolean,
    read: (url: URL, variables: Record<string, string | string[]>) => unknown,
  ) {
    const handler = async (url: URL, variables: Record<string, string | string[]> = {}) => {
      const reply = (text: string) => ({ contents: [{ uri: url.href, mimeType: "application/json", text }] });
      if (!record) {
        logs.flush();
        try {
          return reply(JSON.stringify(await read(url, variables)));
        } catch (error) {
          if (!(error instanceof DakError)) logs.lifecycle.error(error instanceof Error ? error.message : String(error), undefined, error);
          throw error;
        }
      }
      return reply(await scope.run({ resourceUri: url.href }, async () => JSON.stringify(await read(url, variables))));
    };
    const config = { title: name, description, mimeType: "application/json" };
    if (typeof uri === "string") server.registerResource(name, uri, config, (url) => handler(url));
    else server.registerResource(name, uri, config, (url, variables) => handler(url, variables as Record<string, string | string[]>));
  }

  tool(
    "list_objects",
    "Catalogs; schemas of catalog; tables of catalog and schema. pattern: substring or glob.",
    z.object({ catalog: z.string().optional(), schema: z.string().optional(), pattern: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
    async (args) => (await workspace()).metadata.listObjects(args),
  );
  tool(
    "describe_table",
    "Columns, keys and tags of catalog.schema.table; optional sample and lineage. Sample or lineage problems are reported in notes.",
    z.object({ full_name: z.string(), sample_rows: z.number().int().min(1).max(100).optional(), lineage: z.boolean().optional() }),
    async (args) => (await workspace()).metadata.describeTable(args.full_name, { sampleRows: args.sample_rows, lineage: args.lineage }),
  );
  tool(
    "search_metadata",
    "Find tables and columns by name or comment.",
    z.object({ query: z.string().min(1), catalog: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
    async (args) => (await workspace()).metadata.searchMetadata(args),
  );
  tool(
    "execute_sql",
    `Run one SQL statement${deps.allowWrites === true ? " (writes enabled)" : ". Read-only: SHOW, DESCRIBE, DESC, EXPLAIN run directly; others must pass DESCRIBE QUERY (queries only); writes need --allow-writes"}. Use :name parameters. export writes the full result to a file; poll get_statement.`,
    z.object({
      statement: z.string().min(1),
      parameters: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]), type: z.string().optional() })).optional(),
      catalog: z.string().optional(),
      schema: z.string().optional(),
      row_limit: z.number().int().min(1).optional(),
      warehouse_id: z.string().optional(),
      export: z.object({ format: z.enum(["csv", "parquet", "sqlite"]), name: z.string().max(64).optional() }).optional(),
    }),
    async (args) => {
      const { statements, exports } = await workspace();
      const request = { statement: args.statement, parameters: args.parameters, catalog: args.catalog, schema: args.schema, warehouseId: args.warehouse_id };
      if (args.export === undefined) return statements.submit({ ...request, rowLimit: args.row_limit }, "agent");
      const state = await exports.start({ statement: request, format: args.export.format, name: args.export.name });
      return { statementId: state.statementId, state: "PENDING", export: state };
    },
  );
  tool(
    "get_statement",
    "Poll or cancel a statement or export of execute_sql.",
    z.object({ statement_id: z.string(), wait_seconds: z.number().int().min(0).max(30).optional(), cancel: z.boolean().optional() }),
    async (args) => {
      const { statements, exports } = await workspace();
      const lookup = createStatementLookup({ statements, exports });
      return args.cancel === true ? lookup.cancel(args.statement_id) : lookup.get(args.statement_id, { waitSeconds: args.wait_seconds });
    },
  );

  resource("warehouses", "resource://databricks/warehouses", "SQL warehouses visible to this identity and the default one.", true, async () => ({
    warehouses: await (await workspace()).warehouses.list(),
  }));
  resource("recent-errors", "resource://logs/errors/recent", "Most recent error and fatal log entries.", false, () => ({
    generatedAt: new Date().toISOString(),
    errors: repository.recentErrors(RECENT_LIMIT),
  }));
  resource("recent-executions", "resource://logs/executions/recent", "Most recent tool calls and resource reads.", false, () => ({
    executions: repository.recentExecutions(RECENT_LIMIT),
  }));
  resource("stats", "resource://logs/stats", "Execution, error and warning counts for the last 24 hours.", false, () => ({
    last24h: repository.stats(Date.now() - DAY_MS),
  }));
  resource(
    "execution-detail",
    new ResourceTemplate("resource://logs/execution/{executionId}", { list: undefined }),
    "One execution with its full ordered log trail.",
    false,
    (_url, variables) => {
      const executionId = String(variables.executionId);
      const detail = repository.executionDetail(executionId);
      if (detail === undefined) throw new DakError("NOT_FOUND", `Execution '${executionId}' not found (it may be older than the 90-day retention).`);
      return detail;
    },
  );

  return server;
}
