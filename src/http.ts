import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { localhostHostValidation, NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import { ConfigError } from "./errors.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string | undefined;
  createServer: () => McpServer;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function hasValidToken(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const loopback = LOOPBACK_HOSTS.has(options.host);
  if (!loopback && options.token === undefined) {
    throw new ConfigError(
      `Binding the HTTP transport to ${options.host} requires DAK_HTTP_TOKEN; clients must then send "Authorization: Bearer <token>".`,
    );
  }
  const validateHost = loopback ? localhostHostValidation() : undefined;
  const { token } = options;

  const httpServer = createServer(async (request, response) => {
    try {
      if (validateHost !== undefined && !validateHost(request, response)) return;
      if (token !== undefined && !hasValidToken(request, token)) {
        response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
        response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found; the MCP endpoint is /mcp" }));
        return;
      }
      const mcpServer = options.createServer();
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      process.stderr.write(`dak: HTTP request failed: ${(error as Error).message}\n`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  const urlHost = options.host.includes(":") ? `[${options.host}]` : options.host;
  return {
    url: `http://${urlHost}:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}
