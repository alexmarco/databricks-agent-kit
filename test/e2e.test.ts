import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ExportState } from "../src/export/types.ts";
import { openLogRepository } from "../src/logging/repository.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TOKEN = "e2e-token";
const HTTP_TOKEN = "e2e-http-token-0123456789abcdef0123456789";
const STATEMENTS_PATH = "/api/2.0/sql/statements";

/** CSV chunks served by the presigned origin; only the first one carries the header. */
const EXPORT_CHUNKS = ["id,s\n1,a\n", "2,b\n"];
/** Export statements the stub knows: their statement id and the path prefix of their chunk links. */
const EXPORT_STATEMENTS = new Map([
  ["SELECT * FROM big", { statementId: "big00001-e2e", kind: "big" }],
  ["SELECT * FROM slow", { statementId: "slow0001-e2e", kind: "slow" }],
]);
const EXPORT_KINDS = new Map([...EXPORT_STATEMENTS.values()].map((entry) => [entry.statementId, entry.kind]));

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Cloud storage stand-in on its own origin: serves the export chunks at `/<kind>/<index>` and records the
 * `authorization` header of every request. Chunk 1 of `slow` never answers, so an export of it can be cancelled.
 */
async function startPresignedStub() {
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://stub").pathname;
    requests.push({ path, authorization: request.headers.authorization });
    const [, kind, index] = path.split("/");
    if (kind === "slow" && index === "1") return;
    const body = EXPORT_CHUNKS[Number(index)];
    if (body === undefined) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/csv" }).end(body);
  });
  return { url: await listen(server), requests, close: () => closeServer(server) };
}

function exportLink(presignedUrl: string, kind: string, index: number) {
  return {
    chunk_index: index,
    row_offset: index,
    row_count: 1,
    external_link: `${presignedUrl}/${kind}/${index}?X-Amz-Signature=e2e`,
  };
}

/** Statement of a finished export as Databricks returns it: the manifest and the link of chunk 0. */
function succeededExport(statementId: string, kind: string, presignedUrl: string) {
  return {
    statement_id: statementId,
    status: { state: "SUCCEEDED" },
    manifest: {
      format: "CSV",
      total_chunk_count: 2,
      total_row_count: 2,
      truncated: false,
      schema: {
        column_count: 2,
        columns: [
          { name: "id", type_name: "INT", type_text: "INT", position: 0 },
          { name: "s", type_name: "STRING", type_text: "STRING", position: 1 },
        ],
      },
      chunks: [
        { chunk_index: 0, row_offset: 0, row_count: 1 },
        { chunk_index: 1, row_offset: 1, row_count: 1 },
      ],
    },
    result: { external_links: [exportLink(presignedUrl, kind, 0)] },
  };
}

/**
 * Minimal stand-in for the Databricks REST API surface the server uses, with a presigned origin for exports.
 * `warehouseFailures` answers that many first warehouse listings with 503.
 */
async function startDatabricksStub(options: { warehouseFailures?: number } = {}) {
  const presigned = await startPresignedStub();
  const requests: string[] = [];
  let warehouseFailures = options.warehouseFailures ?? 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, payload: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    requests.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, { error_code: "UNAUTHENTICATED", message: "bad token" });
    const url = new URL(request.url ?? "/", "http://stub");
    if (request.method === "GET" && url.pathname === "/api/2.0/sql/warehouses") {
      if (warehouseFailures > 0) {
        warehouseFailures -= 1;
        return send(503, { error_code: "TEMPORARILY_UNAVAILABLE", message: "try again" });
      }
      return send(200, {
        warehouses: [{ id: "wh-e2e", name: "Serverless Starter", state: "RUNNING", enable_serverless_compute: true }],
      });
    }
    if (request.method === "GET" && url.pathname === "/api/2.1/unity-catalog/tables/main.sales.orders") {
      return send(200, {
        full_name: "main.sales.orders",
        table_type: "MANAGED",
        comment: "Orders",
        columns: [{ name: "order_id", type_text: "bigint", nullable: false }],
      });
    }
    if (request.method === "POST" && url.pathname === STATEMENTS_PATH) {
      const body = await readJson(request);
      const statement = String(body.statement);
      const explain = (...rows: string[]) =>
        send(200, {
          statement_id: "st-explain",
          status: { state: "SUCCEEDED" },
          result: { data_array: rows.map((row) => [row]) },
        });
      const fail = (message: string, sqlState: string) =>
        send(200, {
          statement_id: "st-fail",
          status: { state: "FAILED", error: { error_code: "BAD_REQUEST", message, sql_state: sqlState } },
        });
      if (statement === "DESCRIBE QUERY SELECT 1 AS result") return explain("result");
      if (statement.startsWith("DESCRIBE QUERY DELETE"))
        return fail("[PARSE_SYNTAX_ERROR] Syntax error at or near 'FROM'.", "42601");
      if (statement.startsWith("DESCRIBE QUERY ") && EXPORT_STATEMENTS.has(statement.slice("DESCRIBE QUERY ".length)))
        return explain("id", "s");
      const exported = EXPORT_STATEMENTS.get(statement);
      if (exported !== undefined) {
        if (body.disposition !== "EXTERNAL_LINKS" || body.format !== "CSV" || body.wait_timeout !== "0s")
          return fail(`unexpected export request ${JSON.stringify(body)}`, "42000");
        return send(200, { statement_id: exported.statementId, status: { state: "PENDING" } });
      }
      if (statement === "SELECT 1 AS result") {
        return send(200, {
          statement_id: "st-e2e",
          status: { state: "SUCCEEDED" },
          manifest: { schema: { columns: [{ name: "result", type_text: "INT" }] }, total_row_count: 1 },
          result: { data_array: [["1"]] },
        });
      }
      if (statement.includes("information_schema")) {
        return send(200, {
          statement_id: "st-tags",
          status: { state: "SUCCEEDED" },
          manifest: { schema: { columns: [] }, total_row_count: 0 },
          result: { data_array: [] },
        });
      }
      return send(200, {
        statement_id: "st-fail",
        status: {
          state: "FAILED",
          error: { error_code: "BAD_REQUEST", message: "[TABLE_OR_VIEW_NOT_FOUND] nope", sql_state: "42P01" },
        },
      });
    }
    const statementRoute = /^\/api\/2\.0\/sql\/statements\/([^/]+)(?:\/(cancel|result\/chunks\/(\d+)))?$/.exec(
      url.pathname,
    );
    const kind = EXPORT_KINDS.get(decodeURIComponent(statementRoute?.[1] ?? ""));
    if (statementRoute !== null && kind !== undefined) {
      const [, statementId = "", action, chunkIndex] = statementRoute;
      if (request.method === "POST" && action === "cancel") return send(200, {});
      if (request.method === "GET" && action === undefined)
        return send(200, succeededExport(decodeURIComponent(statementId), kind, presigned.url));
      if (request.method === "GET" && chunkIndex !== undefined)
        return send(200, { external_links: [exportLink(presigned.url, kind, Number(chunkIndex))] });
    }
    return send(404, { error_code: "NOT_FOUND", message: `no route ${url.pathname}` });
  });
  const url = await listen(server);
  return {
    url,
    requests,
    presigned,
    close: async () => {
      await closeServer(server);
      await presigned.close();
    },
  };
}

async function freePort(): Promise<number> {
  const server = createNetServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const exportDirOf = (storageDir: string) => join(storageDir, "export-e2e");

/** Environment of a child without any Databricks credentials: no DATABRICKS_* variables and no config file. */
function bareEnv(storageDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("DATABRICKS_") && !key.startsWith("DAK_")) env[key] = value;
  return {
    ...env,
    DATABRICKS_CONFIG_FILE: join(storageDir, "missing.databrickscfg"),
    DAK_STORAGE_DIR: storageDir,
    DAK_EXPORT_DIR: exportDirOf(storageDir),
  };
}

function childEnv(stubUrl: string, storageDir: string): Record<string, string> {
  return { ...bareEnv(storageDir), DATABRICKS_HOST: stubUrl, DATABRICKS_TOKEN: TOKEN };
}

function spawnHttpChild(port: number, env: Record<string, string>): ChildProcess & { stderr: NodeJS.ReadableStream } {
  return spawn(process.execPath, [cliPath, "mcp", "--transport", "http", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Resolves with the MCP endpoint URL once the HTTP child reports it is listening. */
function waitForHttpUrl(child: ChildProcess & { stderr: NodeJS.ReadableStream }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
}

/** Stops the child with SIGTERM, then SIGKILL if it has not exited after `graceMs`. */
async function stopChild(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

const text = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0]?.text ?? "";
const resourceJson = (contents: Array<{ text: string } | { blob: string }>) => {
  const first = contents[0];
  return JSON.parse(first !== undefined && "text" in first ? first.text : "{}");
};
const readResourceJson = async (client: Client, uri: string) =>
  resourceJson((await client.readResource({ uri })).contents);

/** Calls a tool that must succeed and parses its JSON text. */
async function callJson(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, text(result));
  return JSON.parse(text(result));
}

/** Polls `get_statement` with `wait_seconds` until the export reaches a final state. */
async function waitForExport(client: Client, statementId: string): Promise<ExportState> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { export: state } = (await callJson(client, "get_statement", {
      statement_id: statementId,
      wait_seconds: 5,
    })) as { export: ExportState };
    if (state.status === "SUCCEEDED" || state.status === "FAILED" || state.status === "CANCELED") return state;
  }
  throw new Error(`Export ${statementId} did not finish`);
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const partFiles = async (dir: string) => (await readdir(dir)).filter((name) => name.endsWith(".part"));

/** Exports `SELECT * FROM big` as CSV and checks the file, the presigned requests and the absence of `.part` files. */
async function assertBigCsvExport(
  client: Client,
  stub: Awaited<ReturnType<typeof startDatabricksStub>>,
  exportDir: string,
): Promise<void> {
  const started = await callJson(client, "execute_sql", {
    statement: "SELECT * FROM big",
    export: { format: "csv", name: "big" },
  });
  assert.equal(started.state, "PENDING");
  assert.equal(started.statementId, "big00001-e2e");
  assert.equal(started.export.id, "big-big00001-e2e");

  const finished = await waitForExport(client, started.statementId);
  assert.equal(finished.status, "SUCCEEDED", `export ended with: ${finished.error}`);
  const file = join(exportDir, "big-big00001-e2e.csv");
  assert.deepEqual(finished.files, [file]);
  assert.equal(finished.rows, 2);
  assert.equal(await readFile(file, "utf8"), "id,s\n1,a\n2,b\n");
  assert.deepEqual(
    stub.presigned.requests
      .filter((request) => request.path.startsWith("/big/"))
      .map((request) => request.path)
      .sort(),
    ["/big/0", "/big/1"],
  );
  assert.ok(stub.requests.includes(`GET ${STATEMENTS_PATH}/big00001-e2e/result/chunks/1`), "chunk 1 gets a fresh link");
  assert.deepEqual(await partFiles(exportDir), []);
}

test("stdio: a real dak mcp process serves tools, enforces read-only and persists logs", {
  timeout: 60_000,
}, async () => {
  const stub = await startDatabricksStub();
  const storageDir = await mkdtemp(join(tmpdir(), "dak-e2e-"));
  const client = new Client({ name: "e2e-stdio", version: "1.0.0" });
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp"],
      env: childEnv(stub.url, storageDir),
      stderr: "pipe",
    });
    await client.connect(transport);

    assert.equal((await client.listTools()).tools.length, 5);
    const select = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1 AS result" } });
    assert.equal(select.isError, undefined, text(select));
    assert.deepEqual(JSON.parse(text(select)).rows, [["1"]]);
    assert.equal(JSON.parse(text(select)).warehouseId, "wh-e2e");

    const write = await client.callTool({
      name: "execute_sql",
      arguments: { statement: "DELETE FROM main.sales.orders" },
    });
    assert.equal(write.isError, true);
    assert.match(text(write), /--allow-writes/);

    const missing = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT * FROM nope" } });
    assert.match(text(missing), /TABLE_OR_VIEW_NOT_FOUND.*42P01/);

    const described = await client.callTool({ name: "describe_table", arguments: { full_name: "main.sales.orders" } });
    assert.equal(JSON.parse(text(described)).fullName, "main.sales.orders");

    const recent = resourceJson((await client.readResource({ uri: "resource://logs/executions/recent" })).contents);
    const failedWrite = recent.executions.find(
      (execution: { toolName?: string; status: string }) =>
        execution.toolName === "execute_sql" && execution.status === "failed",
    );
    assert.ok(failedWrite, "a failed execute_sql execution is listed");
    const detail = resourceJson(
      (await client.readResource({ uri: `resource://logs/execution/${failedWrite.executionId}` })).contents,
    );
    assert.ok(detail.logs.some((log: { level: string }) => log.level === "warn"));

    await client.close();

    const repository = await openLogRepository(join(storageDir, "logs.db"));
    try {
      const executions = repository.recentExecutions(50);
      assert.ok(
        executions.some((execution) => execution.toolName === "execute_sql" && execution.status === "completed"),
      );
      assert.ok(executions.some((execution) => execution.toolName === "describe_table"));
    } finally {
      repository.close();
    }
    assert.ok(stub.requests.includes("GET /api/2.0/sql/warehouses"));
  } finally {
    await client.close();
    await stub.close();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("stdio: exports a multi-chunk CSV through presigned links and cancels a running export", {
  timeout: 60_000,
}, async () => {
  const stub = await startDatabricksStub();
  const storageDir = await mkdtemp(join(tmpdir(), "dak-e2e-"));
  const exportDir = exportDirOf(storageDir);
  const client = new Client({ name: "e2e-stdio-export", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "mcp"],
        env: childEnv(stub.url, storageDir),
        stderr: "pipe",
      }),
    );

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "describe_table",
      "execute_sql",
      "get_statement",
      "list_objects",
      "search_metadata",
    ]);
    const toolsLength = JSON.stringify(tools).length;
    assert.ok(toolsLength <= 2500, `tool definitions take ${toolsLength} characters`);

    await assertBigCsvExport(client, stub, exportDir);

    const statsBefore = await readResourceJson(client, "resource://logs/stats");
    const statsAfter = await readResourceJson(client, "resource://logs/stats");
    assert.equal(statsAfter.last24h.executions, statsBefore.last24h.executions, "reading the stats opens no execution");

    const slow = await callJson(client, "execute_sql", {
      statement: "SELECT * FROM slow",
      export: { format: "csv", name: "slow" },
    });
    assert.equal(slow.state, "PENDING");
    await until(
      () => stub.presigned.requests.some((request) => request.path === "/slow/1"),
      "the download of chunk 1 of slow",
    );
    assert.deepEqual(await partFiles(exportDir), ["slow-slow0001-e2e.csv.part"]);

    const cancelled = await callJson(client, "get_statement", { statement_id: slow.statementId, cancel: true });
    assert.equal(cancelled.cancelled, true);
    const afterCancel = await callJson(client, "get_statement", { statement_id: slow.statementId });
    assert.equal(afterCancel.export.status, "CANCELED");
    assert.ok(
      stub.requests.includes(`POST ${STATEMENTS_PATH}/slow0001-e2e/cancel`),
      "the statement is cancelled in Databricks",
    );
    assert.deepEqual(await partFiles(exportDir), []);
    assert.deepEqual((await readdir(exportDir)).sort(), ["big-big00001-e2e.csv"]);

    assert.ok(stub.presigned.requests.length >= 4);
    assert.deepEqual(
      stub.presigned.requests.filter((request) => request.authorization !== undefined),
      [],
      "the presigned origin never sees an authorization header",
    );
  } finally {
    await client.close();
    await stub.close();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("stdio: serves the log resources without any Databricks credentials", { timeout: 30_000 }, async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "dak-e2e-"));
  const client = new Client({ name: "e2e-stdio-bare", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "mcp"],
        env: bareEnv(storageDir),
        stderr: "pipe",
      }),
    );
    assert.equal((await client.listTools()).tools.length, 5);
    const stats = await readResourceJson(client, "resource://logs/stats");
    assert.equal(typeof stats.last24h.executions, "number");
    const executions = await readResourceJson(client, "resource://logs/executions/recent");
    assert.ok(Array.isArray(executions.executions));
    const errors = await readResourceJson(client, "resource://logs/errors/recent");
    assert.deepEqual(errors.errors, []);
  } finally {
    await client.close();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("http: a real dak mcp process serves Streamable HTTP on loopback", { timeout: 60_000 }, async () => {
  const stub = await startDatabricksStub();
  const storageDir = await mkdtemp(join(tmpdir(), "dak-e2e-"));
  const port = await freePort();
  const child = spawnHttpChild(port, childEnv(stub.url, storageDir));
  const client = new Client({ name: "e2e-http", version: "1.0.0" });
  try {
    const url = await waitForHttpUrl(child);
    assert.equal(url, `http://127.0.0.1:${port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    assert.equal((await client.listTools()).tools.length, 5);
    const select = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1 AS result" } });
    assert.deepEqual(JSON.parse(text(select)).rows, [["1"]]);
    await assertBigCsvExport(client, stub, exportDirOf(storageDir));
    assert.deepEqual(
      stub.presigned.requests.filter((request) => request.authorization !== undefined),
      [],
    );
  } finally {
    await client.close();
    await stopChild(child);
    await stub.close();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("http: rejected requests and Databricks retries are logged as warnings, the 401 once per minute", {
  timeout: 60_000,
}, async () => {
  const stub = await startDatabricksStub({ warehouseFailures: 1 });
  const storageDir = await mkdtemp(join(tmpdir(), "dak-e2e-"));
  const port = await freePort();
  const child = spawnHttpChild(port, { ...childEnv(stub.url, storageDir), DAK_HTTP_TOKEN: HTTP_TOKEN });
  const client = new Client({ name: "e2e-http-auth", version: "1.0.0" });
  try {
    const url = await waitForHttpUrl(child);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await response.text();
      assert.equal(response.status, 401);
    }

    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${HTTP_TOKEN}` } },
      }),
    );
    const select = await callJson(client, "execute_sql", { statement: "SELECT 1 AS result" });
    assert.deepEqual(select.rows, [["1"]]);
    // Reading a log resource flushes the child's log queue to SQLite.
    await readResourceJson(client, "resource://logs/stats");

    const repository = await openLogRepository(join(storageDir, "logs.db"));
    try {
      const rejections = repository.searchLogs({ level: "warn", text: "HTTP request rejected with 401" });
      assert.equal(rejections.total, 1);
      assert.deepEqual(rejections.results[0]?.metadata, { suppressed: 0 });
      const retries = repository.searchLogs({ level: "warn", text: "Databricks request retried" });
      assert.equal(retries.total, 1);
      assert.equal(retries.results[0]?.metadata?.status, 503);
    } finally {
      repository.close();
    }
  } finally {
    await client.close();
    await stopChild(child);
    await stub.close();
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
