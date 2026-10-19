#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Command, Option } from "commander";
import { sleep } from "./abort.ts";
import { defaultAuthDependencies, resolveAuth } from "./auth.ts";
import { checkBranchPolicy } from "./branch-policy.ts";
import { createClient, type ClientDependencies } from "./client.ts";
import { defaultStorageDir, resolveSettings, type CliFlags, type Settings } from "./config.ts";
import { DOCTOR_LIMITS, ensureWritableDirectory, formatReport, runDoctor } from "./doctor.ts";
import { cleanupOrphanedParts } from "./export/manager.ts";
import { startHttpServer } from "./http.ts";
import { openLogRepository } from "./logging/repository.ts";
import { createRateLimitedLogger } from "./logging/rate-limit.ts";
import { createLogService } from "./logging/service.ts";
import { createMcpServer } from "./server.ts";
import { connectWorkspace, createWorkspaceSession, type WorkspaceAdapters } from "./workspace-session.ts";

const installDir = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")) as { version: string };

const ENVIRONMENT_HELP = `
Environment: DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET,
DATABRICKS_CONFIG_PROFILE, DATABRICKS_CONFIG_FILE, DATABRICKS_WAREHOUSE_ID, DAK_ALLOW_WRITES, DAK_MAX_ROWS,
DAK_HTTP_HOST, DAK_HTTP_PORT, DAK_HTTP_TOKEN, DAK_STORAGE_DIR, DAK_EXPORT_DIR, DAK_EXPORT_MAX_BYTES, DAK_LOG_LEVEL.
`;

const clientDependencies: ClientDependencies = {
  fetch: (input, init) => fetch(input, init),
  sleep,
};

const UNAUTHORIZED_LOG_INTERVAL_MS = 60_000;

function authRequest(settings: Settings) {
  return { profile: settings.profile, explicitProfile: settings.explicitProfile, env: process.env };
}

/** The real credentials, client, `fetch` and timer behind the workspace session. */
function workspaceAdapters(settings: Settings): WorkspaceAdapters {
  return {
    resolveAuth: (onRefresh) => resolveAuth(authRequest(settings), { ...defaultAuthDependencies(process.env), ...(onRefresh && { onRefresh }) }),
    createClient: (auth, observers) => createClient(auth, { ...clientDependencies, ...observers }),
    fetch: clientDependencies.fetch,
    sleep,
  };
}

async function runMcp(settings: Settings): Promise<void> {
  const repository = await openLogRepository(join(settings.storageDir, "logs.db"));
  const logs = createLogService({ repository, transport: settings.transport, level: settings.logLevel });
  // Orphan .part files need no credentials, so they are removed at startup without blocking it.
  void cleanupOrphanedParts(settings.exportDir).catch((error: unknown) => logs.lifecycle.warn("Export cleanup failed", { dir: settings.exportDir }, error));
  const session = createWorkspaceSession(workspaceAdapters(settings), {
    warehouseId: settings.warehouseId,
    limits: { maxRows: settings.maxRows, allowWrites: settings.allowWrites, maxResultBytes: 100_000, maxExportBytes: settings.exportMaxBytes },
    logs,
    exportDir: settings.exportDir,
  });
  const factory = () => createMcpServer({ workspace: session.workspace, scope: session.scope, logs, repository, version, allowWrites: settings.allowWrites });

  let stopTransport: () => Promise<void>;
  try {
    if (settings.transport === "stdio") {
      const handle = serveStdio(factory);
      stopTransport = () => handle.close();
    } else {
      const logRejection = createRateLimitedLogger(
        (suppressed) => logs.lifecycle.warn("HTTP request rejected with 401", { suppressed }),
        UNAUTHORIZED_LOG_INTERVAL_MS,
        Date.now,
      );
      const http = await startHttpServer({ host: settings.httpHost, port: settings.httpPort, token: settings.httpToken, createServer: factory, onUnauthorized: logRejection });
      process.stderr.write(`dak: MCP server listening on ${http.url}\n`);
      stopTransport = () => http.close();
    }
  } catch (error) {
    logs.lifecycle.fatal("Transport failed to start", { transport: settings.transport }, error);
    logs.close();
    throw error;
  }
  logs.lifecycle.info("Transport ready", { transport: settings.transport, allowWrites: settings.allowWrites });

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    logs.lifecycle.info("Shutting down", { reason });
    await stopTransport().catch(() => undefined);
    await session.close().catch(() => undefined);
    logs.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  if (settings.transport === "stdio") process.stdin.once("end", () => void stop("stdin closed"));
  process.once("beforeExit", () => logs.close());
}

/** Runs every `dak doctor` check against the configured workspace and returns the process exit code. */
async function runDoctorCommand(settings: Settings): Promise<number> {
  const checks = await runDoctor({
    settings,
    connect: () => connectWorkspace(workspaceAdapters(settings), { warehouseId: settings.warehouseId, limits: DOCTOR_LIMITS }),
    runCli: (args) => defaultAuthDependencies(process.env).runCli(args),
    openRepository: openLogRepository,
    fetch: clientDependencies.fetch,
    ensureExportDir: ensureWritableDirectory,
  });
  process.stdout.write(`${formatReport(checks)}\n`);
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

/** Parses the command line, runs the selected command and returns its exit code (undefined while `mcp` keeps serving). */
async function main(argv: string[]): Promise<number | undefined> {
  let exitCode: number | undefined;
  const settingsFrom = (flags: CliFlags) => resolveSettings(flags, process.env, defaultStorageDir(process.env, process.platform, homedir()));
  const profileOption = () => new Option("--profile <name>", "profile in ~/.databrickscfg; environment credentials are then ignored");

  const program = new Command("dak")
    .description("Databricks MCP server for coding agents")
    .version(version, "-v, --version")
    .addHelpText("after", ENVIRONMENT_HELP)
    .showHelpAfterError();
  program
    .command("mcp")
    .description("serve the MCP tools to an agent")
    .addOption(new Option("--transport <transport>", "MCP transport (default: stdio)").choices(["stdio", "http"]))
    .option("--host <host>", "HTTP bind address (default: 127.0.0.1)")
    .option("--port <port>", "HTTP port (default: 8765)")
    .addOption(profileOption())
    .option("--allow-writes", "allow statements that modify data")
    .action(async (flags: CliFlags) => runMcp(settingsFrom(flags)));
  program
    .command("doctor")
    .description("check authentication, permissions and workspace features")
    .addOption(profileOption())
    .action(async (flags: CliFlags) => {
      exitCode = await runDoctorCommand(settingsFrom(flags));
    });
  program
    .command("branch-policy <source> <target>")
    .description("check that a pull request from <source> may target <target> (used by CI)")
    .action((source: string, target: string) => {
      const decision = checkBranchPolicy(source, target);
      if (!decision.allowed) {
        process.stderr.write(`dak: ${decision.reason}\n`);
        exitCode = 1;
      }
    });

  await program.parseAsync(argv, { from: "user" });
  return exitCode;
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
