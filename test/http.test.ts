import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/server.ts";
import { fakeServices, withLogs } from "./helpers.ts";

function rawPost(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("serves MCP over Streamable HTTP on loopback", async () => {
  await withLogs("http", async (context) => {
    const services = fakeServices();
    const http = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: undefined,
      createServer: () => createMcpServer({ ...services, logs: context.logs, repository: context.repository, version: "0" }),
    });
    try {
      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
      const { tools } = await client.listTools();
      assert.equal(tools.length, 12);
      const result = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1" } });
      assert.equal(result.isError, undefined);
      await client.close();
      assert.equal(await rawPost(http.port, { host: "evil.example" }), 403);
      assert.equal(await rawPost(http.port, { host: `127.0.0.1:${http.port}` }) < 400, true);
    } finally {
      await http.close();
    }
  });
});

test("requires the bearer token when one is configured", async () => {
  await withLogs("http", async (context) => {
    const services = fakeServices();
    const http = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: "s3cret",
      createServer: () => createMcpServer({ ...services, logs: context.logs, repository: context.repository, version: "0" }),
    });
    try {
      assert.equal(await rawPost(http.port, { host: `127.0.0.1:${http.port}` }), 401);
      assert.equal(await rawPost(http.port, { host: `127.0.0.1:${http.port}`, authorization: "Bearer wrong" }), 401);
      assert.equal((await rawPost(http.port, { host: `127.0.0.1:${http.port}`, authorization: "Bearer s3cret" })) < 400, true);
    } finally {
      await http.close();
    }
  });
});

test("refuses to bind to a non-loopback address without a token and serves 404 elsewhere", async () => {
  await assert.rejects(
    startHttpServer({ host: "0.0.0.0", port: 0, token: undefined, createServer: () => { throw new Error("unused"); } }),
    /DAK_HTTP_TOKEN/,
  );
});
