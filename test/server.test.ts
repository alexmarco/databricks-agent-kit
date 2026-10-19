import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AuthError } from "../src/errors.ts";
import { createMcpServer, TOOL_NAMES, type ServerDependencies } from "../src/server.ts";
import { fakeServices, okResult, withLogs } from "./helpers.ts";
import type { LogRepository } from "../src/logging/repository.ts";
import type { LogService } from "../src/logging/service.ts";

async function connect(context: { repository: LogRepository; logs: LogService }, overrides: Partial<ServerDependencies> = {}) {
  const services = fakeServices(context.logs);
  const server = createMcpServer({ ...services, logs: context.logs, repository: context.repository, version: "0.0.0-test", ...overrides });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server, services };
}

async function closeAll(connection: { client: Client; server: { close(): Promise<void> } }) {
  await connection.client.close();
  await connection.server.close();
}

/** Log entries of the most recent execution of `toolName`. */
function toolLogs(context: { repository: LogRepository; logs: LogService }, toolName: string) {
  context.logs.flush();
  const execution = context.repository.recentExecutions(50).find((candidate) => candidate.toolName === toolName);
  assert.ok(execution, `an execution of ${toolName} is recorded`);
  return { execution, logs: context.repository.executionDetail(execution.executionId)?.logs ?? [] };
}

const resourceText = (contents: Array<{ text: string } | { blob: string }>) => {
  const first = contents[0];
  return first !== undefined && "text" in first ? first.text : "";
};

const text = (result: { content?: unknown }) => ((result.content as Array<{ type: string; text: string }>)[0]?.text ?? "");

test("exposes the 5 tools within the description budget and instructions that give the MCP precedence over the CLI", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const { tools } = await connection.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["describe_table", "execute_sql", "get_statement", "list_objects", "search_metadata"]);
    assert.deepEqual([...TOOL_NAMES].sort(), tools.map((tool) => tool.name).sort());
    assert.ok(JSON.stringify(tools).length <= 2500, `tools take ${JSON.stringify(tools).length} characters`);
    const instructions = connection.client.getInstructions() ?? "";
    assert.match(instructions, /instead of the Databricks CLI/i);
    for (const name of TOOL_NAMES) assert.ok(instructions.includes(name), `instructions mention ${name}`);
    const executeSql = tools.find((tool) => tool.name === "execute_sql");
    assert.match(executeSql?.description ?? "", /read-only/i);
    assert.match(executeSql?.description ?? "", /DESCRIBE QUERY/);
    assert.doesNotMatch(executeSql?.description ?? "", /DESCRIBE QUERY or EXPLAIN/);
    assert.equal(executeSql?.annotations?.readOnlyHint, false);
    const getStatement = tools.find((tool) => tool.name === "get_statement");
    assert.equal(getStatement?.annotations?.readOnlyHint, false);
    assert.equal(getStatement?.annotations?.destructiveHint, false);
    for (const name of ["list_objects", "describe_table", "search_metadata"]) {
      assert.equal(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
    }
    await closeAll(connection);
  });
});

test("execute_sql maps arguments and returns JSON text", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const result = await connection.client.callTool({
      name: "execute_sql",
      arguments: { statement: "SELECT :x", parameters: [{ name: "x", value: 1, type: "INT" }], catalog: "main", schema: "default", row_limit: 5, warehouse_id: "wh9" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(text(result)).rows, [["1"]]);
    assert.deepEqual(connection.services.sqlRequests[0], {
      statement: "SELECT :x",
      parameters: [{ name: "x", value: 1, type: "INT" }],
      catalog: "main",
      schema: "default",
      rowLimit: 5,
      warehouseId: "wh9",
    });
    assert.equal(connection.services.exportCalls.start.length, 0);
    await closeAll(connection);
  });
});

test("execute_sql with export starts a background export and returns its descriptor", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const result = await connection.client.callTool({
      name: "execute_sql",
      arguments: { statement: "SELECT * FROM big", catalog: "main", row_limit: 5, export: { format: "parquet", name: "big-orders" } },
    });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(connection.services.exportCalls.start, [
      { statement: { statement: "SELECT * FROM big", parameters: undefined, catalog: "main", schema: undefined, warehouseId: undefined }, format: "parquet", name: "big-orders" },
    ]);
    assert.equal(connection.services.sqlRequests.length, 0);
    const payload = JSON.parse(text(result));
    assert.equal(payload.statementId, "st-export");
    assert.equal(payload.state, "PENDING");
    assert.equal(payload.export.format, "parquet");
    assert.equal(payload.export.status, "PENDING");
    const entry = toolLogs(context, "execute_sql").logs.filter((log) => log.level === "info")[0]?.metadata ?? {};
    assert.equal(entry.statementId, "st-export");
    assert.equal(entry.warehouseId, "wh-export");
    assert.equal(entry.checkMs, 3);
    const invalid = await connection.client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1", export: { format: "xlsx" } } });
    assert.equal(invalid.isError, true);
    await closeAll(connection);
  });
});

test("get_statement returns export states, waits for them, cancels exports and falls back to the statement", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const { client, services } = connection;
    await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT * FROM big", export: { format: "csv" } } });

    const known = JSON.parse(text(await client.callTool({ name: "get_statement", arguments: { statement_id: "st-export" } })));
    assert.equal(known.statementId, "st-export");
    assert.equal(known.export.status, "PENDING");
    assert.deepEqual(services.exportCalls.wait, []);

    const waited = JSON.parse(text(await client.callTool({ name: "get_statement", arguments: { statement_id: "st-export", wait_seconds: 3 } })));
    assert.equal(waited.export.id, "export-1");
    assert.deepEqual(services.exportCalls.wait, [{ statementId: "st-export", timeoutMs: 3000 }]);

    const cancelled = JSON.parse(text(await client.callTool({ name: "get_statement", arguments: { statement_id: "st-export", cancel: true } })));
    assert.deepEqual(cancelled, { statementId: "st-export", cancelled: true });
    assert.deepEqual(services.exportCalls.cancel, ["st-export"]);
    // The export manager cancels the Databricks statement of an export itself.
    assert.deepEqual(services.cancelledStatements, []);

    const unknown = JSON.parse(text(await client.callTool({ name: "get_statement", arguments: { statement_id: "st-plain", cancel: true } })));
    assert.deepEqual(unknown, { statementId: "st-plain", cancelled: true });
    assert.deepEqual(services.cancelledStatements, ["st-plain"]);

    const plain = JSON.parse(text(await client.callTool({ name: "get_statement", arguments: { statement_id: "st-other", wait_seconds: 2 } })));
    assert.equal(plain.statementId, "st-other");
    assert.deepEqual(plain.rows, [["1"]]);
    assert.deepEqual(services.getStatementCalls, [{ statementId: "st-other", options: { waitSeconds: 2 } }]);

    const tooLong = await client.callTool({ name: "get_statement", arguments: { statement_id: "st-other", wait_seconds: 31 } });
    assert.equal(tooLong.isError, true);
    await closeAll(connection);
  });
});

test("get_statement does not report a finished export as cancelled", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const { client, services } = connection;
    await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT * FROM big", export: { format: "csv" } } });
    services.exportStates.get("st-export")!.status = "SUCCEEDED";

    const answer = JSON.parse(text(await client.callTool({ name: "get_statement", arguments: { statement_id: "st-export", cancel: true } })));
    assert.equal(answer.statementId, "st-export");
    assert.equal(answer.cancelled, false);
    assert.equal(answer.export.status, "SUCCEEDED");
    assert.deepEqual(services.exportCalls.cancel, ["st-export"]);
    assert.deepEqual(services.cancelledStatements, []);
    await closeAll(connection);
  });
});

test("metadata tools delegate to the metadata service", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(text(await connection.client.callTool({ name, arguments: args })));
    assert.equal((await call("list_objects", {})).level, "catalogs");
    assert.deepEqual((await call("list_objects", { catalog: "main" })).items, [{ name: "main-schema" }]);
    const described = await call("describe_table", { full_name: "main.s.t", sample_rows: 5, lineage: true });
    assert.equal(described.fullName, "main.s.t");
    assert.deepEqual(described.sample.rows, [["1"]]);
    assert.deepEqual(described.lineage, { upstream: [], downstream: [] });
    assert.equal((await call("search_metadata", { query: "orders" }))[0].table, "orders");
    const tooMany = await connection.client.callTool({ name: "describe_table", arguments: { full_name: "main.s.t", sample_rows: 101 } });
    assert.equal(tooMany.isError, true);
    await closeAll(connection);
  });
});

test("a tool call writes exactly one info entry with described arguments and the result summary", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const longStatement = `SELECT '${"x".repeat(5000)}'`;
    await connection.client.callTool({ name: "execute_sql", arguments: { statement: longStatement, parameters: [{ name: "secret_value", value: "hunter2", type: "STRING" }] } });
    const { execution, logs } = toolLogs(context, "execute_sql");
    assert.equal(execution.status, "completed");
    const infos = logs.filter((log) => log.level === "info");
    assert.equal(infos.length, 1);
    const metadata = infos[0]!.metadata ?? {};
    assert.match(String(metadata.statement), /…\[\+\d+ chars\]$/);
    assert.ok(String(metadata.statement).length < longStatement.length);
    assert.deepEqual(metadata.parameters, [{ name: "secret_value", type: "STRING" }]);
    assert.ok(!JSON.stringify(logs).includes("hunter2"));
    assert.equal(typeof metadata.durationMs, "number");
    assert.equal(metadata.statementId, "st1");
    assert.equal(metadata.warehouseId, "wh1");
    assert.equal(metadata.state, "SUCCEEDED");
    assert.equal(metadata.rowCount, 1);
    assert.equal(metadata.truncated, false);
    await closeAll(connection);
  });
});

test("the diagnostics a service annotates during a tool call are logged on its final entry", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    (connection.services.statements as unknown as { submit: () => Promise<unknown> }).submit = async () => {
      connection.services.scope.annotate({ checkMs: 42 });
      return okResult;
    };
    await connection.client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1" } });
    const { logs } = toolLogs(context, "execute_sql");
    assert.equal(logs.filter((log) => log.level === "info")[0]?.metadata?.checkMs, 42);
    await closeAll(connection);
  });
});

test("a DakError fails the execution as a warning without stack trace", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const result = await connection.client.callTool({ name: "execute_sql", arguments: { statement: "FAIL now" } });
    assert.equal(result.isError, true);
    assert.match(text(result), /^\[TABLE_OR_VIEW_NOT_FOUND\]/);
    const { execution, logs } = toolLogs(context, "execute_sql");
    assert.equal(execution.status, "failed");
    assert.equal(logs.length, 1);
    const [entry] = logs;
    assert.equal(entry?.level, "warn");
    assert.equal(entry?.stackTrace, undefined);
    assert.equal(entry?.source, "execute_sql");
    assert.equal(entry?.metadata?.statement, "FAIL now");
    assert.equal(typeof entry?.metadata?.durationMs, "number");
    await closeAll(connection);
  });
});

test("an unexpected error fails the execution as an error with its stack trace", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    (connection.services.statements as unknown as { submit: () => Promise<never> }).submit = async () => {
      throw new Error("driver crashed");
    };
    const result = await connection.client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1" } });
    assert.equal(result.isError, true);
    assert.equal(text(result), "Unexpected error: driver crashed");
    const { execution, logs } = toolLogs(context, "execute_sql");
    assert.equal(execution.status, "failed");
    assert.equal(logs.length, 1);
    const [entry] = logs;
    assert.equal(entry?.level, "error");
    assert.match(entry?.stackTrace ?? "", /Error: driver crashed/);
    assert.equal(entry?.source, "execute_sql");
    assert.equal(entry?.metadata?.statement, "SELECT 1");
    assert.equal(typeof entry?.metadata?.durationMs, "number");
    await closeAll(connection);
  });
});

test("a result that cannot be serialized fails the execution instead of being logged as a success", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    (connection.services.statements as unknown as { submit: () => Promise<unknown> }).submit = async () => ({ ...okResult, rows: [[1n]] });
    const result = await connection.client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1" } });
    assert.equal(result.isError, true);
    const { execution, logs } = toolLogs(context, "execute_sql");
    assert.equal(execution.status, "failed");
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, "error");
    assert.equal(logs[0]?.metadata?.statement, "SELECT 1");
    await closeAll(connection);
  });
});

test("log resources read from SQLite, including the latest calls, without opening executions", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const { client, services } = connection;
    (services.statements as unknown as { submit: () => Promise<never> }).submit = async () => {
      throw new Error("[TABLE_OR_VIEW_NOT_FOUND] missing (SQLSTATE 42P01)");
    };
    await client.callTool({ name: "list_objects", arguments: {} });
    await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT broken" } });

    context.logs.flush();
    const executionsBefore = context.repository.recentExecutions(50);
    const read = async (uri: string) => JSON.parse(resourceText((await client.readResource({ uri })).contents));
    const stats = await read("resource://logs/stats");
    assert.ok(stats.last24h.executions >= 2);
    assert.ok(stats.last24h.errors >= 1);
    const errors = await read("resource://logs/errors/recent");
    assert.ok(typeof errors.generatedAt === "string");
    assert.match(errors.errors[0].message, /TABLE_OR_VIEW_NOT_FOUND/);
    const executions = await read("resource://logs/executions/recent");
    const listObjects = executions.executions.find((execution: { toolName?: string }) => execution.toolName === "list_objects");
    assert.equal(listObjects.status, "completed");
    const detail = await read(`resource://logs/execution/${listObjects.executionId}`);
    assert.equal(detail.execution.executionId, listObjects.executionId);
    assert.equal(detail.logs.length, 1);

    const missing = await client.readResource({ uri: "resource://logs/execution/does-not-exist" }).then(
      (value) => JSON.parse(resourceText(value.contents)),
      (error: Error) => ({ error: error.message }),
    );
    assert.ok("error" in missing);
    context.logs.flush();
    assert.deepEqual(context.repository.recentExecutions(50), executionsBefore);
    assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === "search_logs"));
    await closeAll(connection);
  });
});

test("the warehouses resource lists the SQL warehouses inside a recorded execution", async () => {
  await withLogs("stdio", async (context) => {
    const connection = await connect(context);
    const contents = (await connection.client.readResource({ uri: "resource://databricks/warehouses" })).contents;
    assert.equal(contents[0]?.mimeType, "application/json");
    const payload = JSON.parse(resourceText(contents));
    assert.deepEqual(payload, { warehouses: [{ id: "wh1", name: "Serverless", state: "RUNNING", size: "2X-Small", serverless: true, isDefault: true }] });
    context.logs.flush();
    const execution = context.repository.recentExecutions(50).find((candidate) => candidate.resourceUri === "resource://databricks/warehouses");
    assert.equal(execution?.status, "completed");
    await closeAll(connection);
  });
});

test("an unexpected error while reading a log resource is logged on the lifecycle execution and rethrown", async () => {
  await withLogs("stdio", async (context) => {
    const repository = Object.create(context.repository) as LogRepository;
    repository.stats = () => {
      throw new Error("disk gone");
    };
    const server = createMcpServer({ ...fakeServices(context.logs), logs: context.logs, repository, version: "0.0.0-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    await assert.rejects(client.readResource({ uri: "resource://logs/stats" }), /disk gone/);
    const missing = await client.readResource({ uri: "resource://logs/execution/does-not-exist" }).then(() => undefined, (error: Error) => error);
    assert.ok(missing instanceof Error);
    context.logs.flush();
    const lifecycle = context.repository.executionDetail(context.logs.lifecycle.executionId)?.logs ?? [];
    const errors = lifecycle.filter((log) => log.level === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, "disk gone");
    assert.match(errors[0]?.stackTrace ?? "", /Error: disk gone/);
    await closeAll({ client, server });
  });
});

test("a call whose workspace cannot be created returns the error as one warn entry, and the next call succeeds", async () => {
  await withLogs("stdio", async (context) => {
    const { workspace } = fakeServices(context.logs);
    let failures = 1;
    const connection = await connect(context, {
      workspace: async () => {
        if (failures-- > 0) throw new AuthError("No Databricks credentials found. Run `databricks auth login`");
        return workspace();
      },
    });
    const failed = await connection.client.callTool({ name: "list_objects", arguments: {} });
    assert.equal(failed.isError, true);
    assert.match(text(failed), /databricks auth login/);
    const { execution, logs } = toolLogs(context, "list_objects");
    assert.equal(execution.status, "failed");
    assert.deepEqual(logs.map((entry) => entry.level), ["warn"]);

    const retried = await connection.client.callTool({ name: "list_objects", arguments: {} });
    assert.equal(retried.isError, undefined);
    await closeAll(connection);
  });
});
