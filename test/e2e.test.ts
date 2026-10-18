import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { openLogRepository } from "../src/logging/repository.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TOKEN = "e2e-token";

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
}

/** Minimal stand-in for the Databricks REST API surface the server uses. */
async function startDatabricksStub() {
  const requests: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, payload: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    requests.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error_code: "UNAUTHENTICATED", message: "bad token" });
    const url = new URL(request.url ?? "/", "http://stub");
    if (request.method === "GET" && url.pathname === "/api/2.0/sql/warehouses") {
      return send(200, { warehouses: [{ id: "wh-e2e", name: "Serverless Starter", state: "RUNNING", enable_serverless_compute: true }] });
    }
    if (request.method === "GET" && url.pathname === "/api/2.1/unity-catalog/tables/main.sales.orders") {
      return send(200, { full_name: "main.sales.orders", table_type: "MANAGED", comment: "Orders", columns: [{ name: "order_id", type_text: "bigint", nullable: false }] });
    }
    if (request.method === "POST" && url.pathname === "/api/2.0/sql/statements") {
      const body = await readJson(request);
      const statement = String(body.statement);
      if (statement === "SELECT 1 AS result") {
        return send(200, { statement_id: "st-e2e", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [{ name: "result", type_text: "INT" }] }, total_row_count: 1 }, result: { data_array: [["1"]] } });
      }
      if (statement.includes("information_schema")) {
        return send(200, { statement_id: "st-tags", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [] }, total_row_count: 0 }, result: { data_array: [] } });
      }
      return send(200, { statement_id: "st-fail", status: { state: "FAILED", error: { error_code: "BAD_REQUEST", message: "[TABLE_OR_VIEW_NOT_FOUND] nope", sql_state: "42P01" } } });
    }
    return send(404, { error_code: "NOT_FOUND", message: `no route ${url.pathname}` });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function freePort(): Promise<number> {
  const server = createNetServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function childEnv(stubUrl: string, storageDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("DATABRICKS_") && !key.startsWith("DAK_")) env[key] = value;
  return { ...env, DATABRICKS_HOST: stubUrl, DATABRICKS_TOKEN: TOKEN, DAK_STORAGE_DIR: storageDir };
}

const text = (result: { content?: unknown }) => ((result.content as Array<{ text: string }>)[0]?.text ?? "");
const resourceJson = (contents: Array<{ text: string } | { blob: string }>) => {
  const first = contents[0];
  return JSON.parse(first !== undefined && "text" in first ? first.text : "{}");
};

test("stdio: a real dak mcp process serves tools, enforces read-only and persists logs", async () => {
  const stub = await startDatabricksStub();
  const storageDir = await mkdtemp(join(tmpdir(), "dak-e2e-"));
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, "mcp"], env: childEnv(stub.url, storageDir), stderr: "pipe" });
    const client = new Client({ name: "e2e-stdio", version: "1.0.0" });
    await client.connect(transport);

    assert.equal((await client.listTools()).tools.length, 12);
    const select = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1 AS result" } });
    assert.equal(select.isError, undefined, text(select));
    assert.deepEqual(JSON.parse(text(select)).rows, [["1"]]);
    assert.equal(JSON.parse(text(select)).warehouseId, "wh-e2e");

    const write = await client.callTool({ name: "execute_sql", arguments: { statement: "DELETE FROM main.sales.orders" } });
    assert.equal(write.isError, true);
    assert.match(text(write), /--allow-writes/);

    const missing = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT * FROM nope" } });
    assert.match(text(missing), /TABLE_OR_VIEW_NOT_FOUND.*42P01/);

    const described = await client.callTool({ name: "describe_table", arguments: { full_name: "main.sales.orders" } });
    assert.equal(JSON.parse(text(described)).fullName, "main.sales.orders");

    const recent = resourceJson((await client.readResource({ uri: "resource://logs/executions/recent" })).contents);
    const failedWrite = recent.executions.find((execution: { toolName?: string; status: string }) => execution.toolName === "execute_sql" && execution.status === "failed");
    assert.ok(failedWrite, "a failed execute_sql execution is listed");
    const detail = resourceJson((await client.readResource({ uri: `resource://logs/execution/${failedWrite.executionId}` })).contents);
    assert.ok(detail.logs.some((log: { level: string }) => log.level === "error"));

    await client.close();

    const repository = await openLogRepository(join(storageDir, "logs.db"));
    try {
      const executions = repository.recentExecutions(50);
      assert.ok(executions.some((execution) => execution.toolName === "execute_sql" && execution.status === "completed"));
      assert.ok(executions.some((execution) => execution.toolName === "describe_table"));
    } finally {
      repository.close();
    }
    assert.ok(stub.requests.includes("GET /api/2.0/sql/warehouses"));
  } finally {
    await stub.close();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("http: a real dak mcp process serves Streamable HTTP on loopback", async () => {
  const stub = await startDatabricksStub();
  const storageDir = await mkdtemp(join(tmpdir(), "dak-e2e-"));
  const port = await freePort();
  const child = spawn(process.execPath, [cliPath, "mcp", "--transport", "http", "--port", String(port)], { env: childEnv(stub.url, storageDir), stdio: ["ignore", "ignore", "pipe"] });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("HTTP server did not report readiness within 15 s")), 15_000);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /listening on (http:\/\/\S+)/.exec(stderr);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`dak exited early with code ${code}: ${stderr}`));
      });
    });
    assert.equal(url, `http://127.0.0.1:${port}/mcp`);
    const client = new Client({ name: "e2e-http", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.equal((await client.listTools()).tools.length, 12);
    const select = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1 AS result" } });
    assert.deepEqual(JSON.parse(text(select)).rows, [["1"]]);
    await client.close();
  } finally {
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await stub.close();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
