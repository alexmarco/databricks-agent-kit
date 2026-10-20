import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import { ConfigError } from "./errors.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MIN_TOKEN_LENGTH = 32;

/** Options of the Streamable HTTP transport. */
export interface HttpServerOptions {
  /** Bind address; anything other than loopback requires `token`. */
  host: string;
  /** TCP port; 0 picks a free one. */
  port: number;
  /** Bearer token clients must send, at least 32 characters; undefined disables the check (loopback only). */
  token: string | undefined;
  /** Builds a fresh MCP server for each request (stateless transport). */
  createServer: () => McpServer;
  /** Called once per request rejected with 401; it receives nothing, so it cannot leak the token or headers. A throwing callback is ignored. */
  onUnauthorized?(): void;
}

/** Handle of a listening HTTP transport. */
export interface RunningHttpServer {
  /** MCP endpoint URL, for example `http://127.0.0.1:8765/mcp`. */
  url: string;
  /** Port actually bound, useful when 0 was requested. */
  port: number;
  /** Closes open connections and stops listening. */
  close(): Promise<void>;
}

function hasValidToken(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Serves MCP over Streamable HTTP at `/mcp`. On loopback, foreign `Host` and `Origin` headers are rejected.
 * @throws {ConfigError} When binding off loopback without a token, or when the token is shorter than 32 characters.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const loopback = LOOPBACK_HOSTS.has(options.host);
  if (!loopback && options.token === undefined) {
    throw new ConfigError(
      `Binding the HTTP transport to ${options.host} requires DAK_HTTP_TOKEN; clients must then send "Authorization: Bearer <token>".`,
    );
  }
  if (options.token !== undefined && options.token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `DAK_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters; generate one with \`openssl rand -hex 32\`.`,
    );
  }
  const validateHost = loopback ? localhostHostValidation() : undefined;
  const validateOrigin = loopback ? localhostOriginValidation() : undefined;
  const { token } = options;

  const httpServer = createServer(async (request, response) => {
    try {
      if (validateHost !== undefined && !validateHost(request, response)) return;
      if (validateOrigin !== undefined && !validateOrigin(request, response)) return;
      if (token !== undefined && !hasValidToken(request, token)) {
        try {
          options.onUnauthorized?.();
        } catch {
          // The callback only observes the rejection; its failure must not change the response.
        }
        response
          .writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
          .end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
        response
          .writeHead(404, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "not found; the MCP endpoint is /mcp" }));
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
      if (!response.headersSent)
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "internal error" }));
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
