import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/server.ts";
import { fakeServices, withLogs } from "./helpers.ts";

function rawPost(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let received = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (received += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: received }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const postStatus = async (port: number, headers: Record<string, string>) => (await rawPost(port, headers)).status;

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
      assert.equal(tools.length, 5);
      const result = await client.callTool({ name: "execute_sql", arguments: { statement: "SELECT 1" } });
      assert.equal(result.isError, undefined);
      await client.close();
      assert.equal(await postStatus(http.port, { host: "evil.example" }), 403);
      assert.equal(await postStatus(http.port, { host: `127.0.0.1:${http.port}`, origin: "https://evil.example" }), 403);
      assert.equal(await postStatus(http.port, { host: `127.0.0.1:${http.port}`, origin: `http://localhost:${http.port}` }) < 400, true);
      assert.equal(await postStatus(http.port, { host: `127.0.0.1:${http.port}` }) < 400, true);
    } finally {
      await http.close();
    }
  });
});

const TOKEN = "0123456789abcdef0123456789abcdef";

test("requires the bearer token when one is configured", async () => {
  await withLogs("http", async (context) => {
    const services = fakeServices();
    const http = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      createServer: () => createMcpServer({ ...services, logs: context.logs, repository: context.repository, version: "0" }),
    });
    try {
      assert.equal(await postStatus(http.port, { host: `127.0.0.1:${http.port}` }), 401);
      assert.equal(await postStatus(http.port, { host: `127.0.0.1:${http.port}`, authorization: "Bearer wrong" }), 401);
      assert.equal((await postStatus(http.port, { host: `127.0.0.1:${http.port}`, authorization: `Bearer ${TOKEN}` })) < 400, true);
    } finally {
      await http.close();
    }
  });
});

test("calls onUnauthorized once per rejected request and still answers 401 without echoing the token", async () => {
  await withLogs("http", async (context) => {
    const services = fakeServices();
    let rejections = 0;
    const http = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      onUnauthorized: () => {
        rejections += 1;
      },
      createServer: () => createMcpServer({ ...services, logs: context.logs, repository: context.repository, version: "0" }),
    });
    try {
      const host = `127.0.0.1:${http.port}`;
      const missing = await rawPost(http.port, { host });
      assert.equal(missing.status, 401);
      assert.equal(rejections, 1);
      const wrong = await rawPost(http.port, { host, authorization: "Bearer wrong-token-value" });
      assert.equal(wrong.status, 401);
      assert.equal(rejections, 2);
      for (const body of [missing.body, wrong.body]) {
        assert.equal(body.includes(TOKEN), false);
        assert.equal(body.includes("wrong-token-value"), false);
      }
      assert.equal((await postStatus(http.port, { host, authorization: `Bearer ${TOKEN}` })) < 400, true);
      assert.equal(rejections, 2);
    } finally {
      await http.close();
    }
  });
});

test("a throwing onUnauthorized does not change the 401 response", async () => {
  await withLogs("http", async (context) => {
    const services = fakeServices();
    const http = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      onUnauthorized: () => {
        throw new Error("callback failed");
      },
      createServer: () => createMcpServer({ ...services, logs: context.logs, repository: context.repository, version: "0" }),
    });
    try {
      const response = await rawPost(http.port, { host: `127.0.0.1:${http.port}` });
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(response.body), { error: "unauthorized" });
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
  for (const token of ["", "short"]) {
    await assert.rejects(
      startHttpServer({ host: "0.0.0.0", port: 0, token, createServer: () => { throw new Error("unused"); } }),
      /at least 32 characters/,
    );
  }
});
