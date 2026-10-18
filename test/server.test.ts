import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createMcpServer, TOOL_NAMES } from "../src/server.ts";
import { fakeServices, withLogs } from "./helpers.ts";
import type { LogRepository } from "../src/logging/repository.ts";
import type { LogService } from "../src/logging/service.ts";

async function connect(context: { repository: LogRepository; logs: LogService }) {
  const services = fakeServices();
  const server = createMcpServer({ ...services, logs: context.logs, repository: context.repository, version: "0.0.0-test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server, services };
}

const resourceText = (contents: Array<{ text: string } | { blob: string }>) => {
  const first = contents[0];
  return first !== undefined && "text" in first ? first.text : "";
};

const text = (result: { content?: unknown }) => ((result.content as Array<{ type: string; text: string }>)[0]?.text ?? "");

test("exposes the 12 tools and instructions that give the MCP precedence over the CLI", async () => {
  await withLogs("stdio", async (context) => {
    const { client, server } = await connect(context);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    assert.equal(TOOL_NAMES.length, 12);
    assert.match(client.getInstructions() ?? "", /instead of the Databricks CLI/i);
    const executeSql = tools.find((tool) => tool.name === "execute_sql");
    assert.ok(executeSql?.description?.includes("read-only"));
    await client.close();
    await server.close();
  });
});

test("execute_sql maps arguments and returns JSON text", async () => {
  await withLogs("stdio", async (context) => {
    const { client, server, services } = await connect(context);
    const result = await client.callTool({
      name: "execute_sql",
      arguments: { statement: "SELECT :x", parameters: [{ name: "x", value: 1, type: "INT" }], catalog: "main", schema: "default", row_limit: 5, warehouse_id: "wh9" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(text(result)).rows, [["1"]]);
    assert.deepEqual(services.sqlRequests[0], {
      statement: "SELECT :x",
      parameters: [{ name: "x", value: 1, type: "INT" }],
      catalog: "main",
      schema: "default",
      rowLimit: 5,
      warehouseId: "wh9",
    });
    await client.close();
    await server.close();
  });
});

test("metadata tools delegate to the metadata service", async () => {
  await withLogs("stdio", async (context) => {
    const { client, server } = await connect(context);
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: "list_schemas", arguments: { catalog: "main" } }))), [{ name: "main-schema" }]);
    assert.equal(JSON.parse(text(await client.callTool({ name: "describe_table", arguments: { full_name: "main.s.t" } }))).fullName, "main.s.t");
    assert.equal(JSON.parse(text(await client.callTool({ name: "table_lineage", arguments: { full_name: "a.b.c" } }))).table, "a.b.c");
    assert.equal(JSON.parse(text(await client.callTool({ name: "list_warehouses", arguments: {} })))[0].id, "wh1");
    await client.close();
    await server.close();
  });
});

test("tool errors return isError and record a failed execution with its stack trace", async () => {
  await withLogs("stdio", async (context) => {
    const { client, server } = await connect(context);
    const result = await client.callTool({ name: "execute_sql", arguments: { statement: "FAIL now" } });
    assert.equal(result.isError, true);
    assert.match(text(result), /TABLE_OR_VIEW_NOT_FOUND/);
    context.logs.flush();
    const failed = context.repository.recentExecutions(10).find((execution) => execution.toolName === "execute_sql");
    assert.equal(failed?.status, "failed");
    const detail = context.repository.executionDetail(failed!.executionId);
    assert.ok(detail?.logs.some((log) => log.level === "error" && log.stackTrace?.includes("SqlError")));
    assert.ok(detail?.logs.some((log) => log.metadata?.statement === "FAIL now"));
    await client.close();
    await server.close();
  });
});

test("log resources and search_logs read from SQLite, including the latest calls", async () => {
  await withLogs("stdio", async (context) => {
    const { client, server } = await connect(context);
    await client.callTool({ name: "list_catalogs", arguments: {} });
    await client.callTool({ name: "execute_sql", arguments: { statement: "FAIL again" } });

    const read = async (uri: string) => JSON.parse(resourceText((await client.readResource({ uri })).contents));
    const stats = await read("resource://logs/stats");
    assert.ok(stats.last24h.executions >= 2);
    assert.ok(stats.last24h.errors >= 1);
    const errors = await read("resource://logs/errors/recent");
    assert.ok(typeof errors.generatedAt === "string");
    assert.match(errors.errors[0].message, /TABLE_OR_VIEW_NOT_FOUND/);
    const executions = await read("resource://logs/executions/recent");
    const listCatalogs = executions.executions.find((execution: { toolName?: string }) => execution.toolName === "list_catalogs");
    assert.equal(listCatalogs.status, "completed");
    const detail = await read(`resource://logs/execution/${listCatalogs.executionId}`);
    assert.equal(detail.execution.executionId, listCatalogs.executionId);
    assert.ok(detail.logs.length >= 2);

    const search = JSON.parse(text(await client.callTool({ name: "search_logs", arguments: { level: "error", limit: 5 } })));
    assert.ok(search.total >= 1);
    assert.equal(search.results[0].level, "error");

    const missing = await client.readResource({ uri: "resource://logs/execution/does-not-exist" }).then(
      (value) => JSON.parse(resourceText(value.contents)),
      (error: Error) => ({ error: error.message }),
    );
    assert.ok("error" in missing);
    const resourceReads = context.repository.recentExecutions(50).filter((execution) => execution.resourceUri !== undefined);
    assert.ok(resourceReads.length >= 4);
    await client.close();
    await server.close();
  });
});
