#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { defaultAuthDependencies, resolveAuth } from "./auth.ts";
import { createClient, type ClientDependencies } from "./client.ts";
import { resolveSettings, type Settings } from "./config.ts";
import { formatReport, runDoctor } from "./doctor.ts";
import { startHttpServer } from "./http.ts";
import { openLogRepository } from "./logging/repository.ts";
import { createLogService } from "./logging/service.ts";
import { createMetadataService, type MetadataService } from "./metadata.ts";
import { createMcpServer } from "./server.ts";
import { createSqlService, type SqlService } from "./sql.ts";

const installDir = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")) as { version: string };

const USAGE = `dak ${version} - Databricks MCP server for coding agents

Usage:
  dak mcp [--transport stdio|http] [--host <host>] [--port <port>] [--profile <name>] [--allow-writes]
  dak doctor [--profile <name>]
  dak --version

Environment: DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET,
DATABRICKS_CONFIG_PROFILE, DATABRICKS_CONFIG_FILE, DATABRICKS_WAREHOUSE_ID, DAK_ALLOW_WRITES, DAK_MAX_ROWS,
DAK_HTTP_HOST, DAK_HTTP_PORT, DAK_HTTP_TOKEN, DAK_STORAGE_DIR, DAK_LOG_LEVEL.
`;

const clientDependencies: ClientDependencies = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Retries the loader on the next call when it fails, so fixing credentials does not require a restart. */
function memoizeUntilSuccess<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/** Defers every async method call until the real service exists. */
function lazy<T extends object>(load: () => Promise<T>): T {
  return new Proxy({} as T, {
    get: (_target, key) => async (...args: unknown[]) => {
      const target = (await load()) as Record<PropertyKey, (...callArgs: unknown[]) => unknown>;
      return target[key]!.apply(target, args);
    },
  });
}

function authRequest(settings: Settings) {
  return { profile: settings.profile, explicitProfile: settings.explicitProfile, env: process.env };
}

async function runMcp(settings: Settings): Promise<void> {
  const repository = await openLogRepository(join(settings.storageDir, "logs.db"));
  const logs = createLogService({ repository, transport: settings.transport, level: settings.logLevel });
  const services = memoizeUntilSuccess(async () => {
    const auth = await resolveAuth(authRequest(settings), defaultAuthDependencies(process.env));
    const client = createClient(auth, clientDependencies);
    const sql = createSqlService(client, {
      maxRows: settings.maxRows,
      allowWrites: settings.allowWrites,
      defaultWarehouseId: settings.warehouseId ?? auth.profileWarehouseId,
      maxResultBytes: 100_000,
    });
    logs.lifecycle.info("Databricks credentials resolved", { host: auth.host, method: auth.method });
    return { sql, metadata: createMetadataService(client, sql) };
  });
  const sql = lazy<SqlService>(async () => (await services()).sql);
  const metadata = lazy<MetadataService>(async () => (await services()).metadata);
  const factory = () => createMcpServer({ sql, metadata, logs, repository, version, allowWrites: settings.allowWrites });

  let stopTransport: () => Promise<void>;
  if (settings.transport === "stdio") {
    const handle = serveStdio(factory);
    stopTransport = () => handle.close();
  } else {
    const http = await startHttpServer({ host: settings.httpHost, port: settings.httpPort, token: settings.httpToken, createServer: factory });
    process.stderr.write(`dak: MCP server listening on ${http.url}\n`);
    stopTransport = () => http.close();
  }
  logs.lifecycle.info("Transport ready", { transport: settings.transport, allowWrites: settings.allowWrites });

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    logs.lifecycle.info("Shutting down", { reason });
    await stopTransport().catch(() => undefined);
    logs.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  if (settings.transport === "stdio") process.stdin.once("end", () => void stop("stdin closed"));
  process.once("beforeExit", () => logs.close());
}

async function main(argv: string[]): Promise<number | undefined> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      "allow-writes": { type: "boolean" },
      transport: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version === true) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  const [command] = positionals;
  if (values.help === true || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }

  const settings = resolveSettings(values, process.env, installDir);
  if (command === "mcp") {
    await runMcp(settings);
    return undefined;
  }
  if (command === "doctor") {
    const checks = await runDoctor({
      settings,
      resolveAuth: () => resolveAuth(authRequest(settings), defaultAuthDependencies(process.env)),
      createClient: (auth) => createClient(auth, clientDependencies),
      runCli: (args) => defaultAuthDependencies(process.env).runCli(args),
      openRepository: openLogRepository,
    });
    process.stdout.write(`${formatReport(checks)}\n`);
    return checks.some((check) => check.status === "fail") ? 1 : 0;
  }
  process.stderr.write(`Unknown command '${command}'.\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`dak: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
