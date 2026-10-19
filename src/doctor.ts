import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthProvider, FetchLike } from "./auth.ts";
import type { DatabricksClient } from "./client.ts";
import type { Settings } from "./config.ts";
import { messageWithoutUrls } from "./errors.ts";
import { createSqlService } from "./sql.ts";
import type { StatementLifecycle, StatementLifecycleOptions } from "./statements.ts";

/** The part of the statement lifecycle that the doctor uses. */
export type DoctorStatements = Pick<StatementLifecycle, "submit" | "submitExport" | "awaitExport" | "exportChunkLink" | "cancel">;

/** Outcome of a check: `fail` makes `dak doctor` exit with code 1, `warn` only marks an optional feature as unavailable. */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

/** One line of the doctor report. */
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Manual step that fixes a failed or degraded check. */
  next?: string;
}

/** Everything the doctor touches, injected so tests run without a workspace. */
export interface DoctorDependencies {
  settings: Settings;
  resolveAuth(): Promise<AuthProvider>;
  createClient(auth: AuthProvider): DatabricksClient;
  /** Creates the statement lifecycle for the checks; tests inject a fake of its interface. */
  createStatements(client: DatabricksClient, options: StatementLifecycleOptions): DoctorStatements;
  runCli(args: string[]): Promise<string>;
  openRepository(path: string): Promise<{ close(): void }>;
  /** Plain `fetch`, used to download an export link exactly as the export manager does. */
  fetch: FetchLike;
  /** Creates the directory if needed, then writes and deletes a temporary file in it; throws when it is not writable. */
  ensureExportDir(dir: string): Promise<void>;
}

const REMOTE_CHECKS = ["Identity", "SQL warehouse", "SQL execution", "information_schema", "Lineage system tables", "Result download"] as const;
const MIN_CLI = [1, 0, 0] as const;
const DOWNLOAD_WAIT_BUDGET_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Creates the export directory (owner-only, like the export manager) if needed and proves it is writable by writing and
 * deleting a temporary file, which never stays behind.
 */
export async function ensureWritableDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const probePath = join(dir, `.dak-doctor-${process.pid}.tmp`);
  try {
    await writeFile(probePath, "", { mode: 0o600 });
  } finally {
    await rm(probePath, { force: true });
  }
}

async function probe(statements: DoctorStatements, statement: string, warehouseId: string): Promise<void> {
  await statements.submit({ statement, warehouseId, rowLimit: 1 }, "server");
}

/**
 * Submits `SELECT 1` as an export and downloads its first link without credentials. The link points to cloud storage,
 * so a proxy or firewall that allows the workspace host can still block it. Only the host of the link is reported.
 * The statement lifecycle owns submitting, polling and the chunk link, as for real exports; the check only bounds the
 * wait for the export to {@link DOWNLOAD_WAIT_BUDGET_MS}.
 */
async function resultDownloadCheck(deps: DoctorDependencies, statements: DoctorStatements, warehouseId: string): Promise<DoctorCheck> {
  const name = "Result download";
  const exportHint = "Exports need EXTERNAL_LINKS results; check that the workspace allows them.";
  const waitBudget = new AbortController();
  let statementId: string | undefined;
  let link: string;
  let host: string;
  const timer = setTimeout(() => waitBudget.abort(), DOWNLOAD_WAIT_BUDGET_MS);
  try {
    ({ statementId } = await statements.submitExport({ statement: "SELECT 1", warehouseId }, "csv"));
    const result = await statements.awaitExport(statementId, waitBudget.signal);
    link = (result.firstLink ?? (await statements.exportChunkLink(statementId, 0, waitBudget.signal))).url;
    host = new URL(link).hostname;
  } catch (error) {
    if (waitBudget.signal.aborted && statementId !== undefined) {
      await statements.cancel(statementId).catch(() => undefined);
      return { name, status: "warn", detail: "warehouse still starting; the export did not finish in 60 s", next: "Run dak doctor again in a minute." };
    }
    return { name, status: "warn", detail: messageWithoutUrls(messageOf(error)), next: exportHint };
  } finally {
    clearTimeout(timer);
  }

  const blocked = "A proxy or firewall may be blocking the cloud storage host of the result links; allow it so exports can download.";
  try {
    const response = await deps.fetch(link, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    const { status } = response;
    // The body is not needed; a failure to release it must not turn a good status into a warning.
    await response.body?.cancel().catch(() => undefined);
    return status === 200
      ? { name, status: "ok", detail: `downloaded a result chunk from ${host}` }
      : { name, status: "warn", detail: `${host} answered ${status}`, next: blocked };
  } catch (error) {
    return { name, status: "warn", detail: `${host}: ${messageWithoutUrls(messageOf(error))}`, next: blocked };
  }
}

async function remoteChecks(deps: DoctorDependencies, auth: AuthProvider): Promise<DoctorCheck[]> {
  const client = deps.createClient(auth);
  const sql = createSqlService(client, { defaultWarehouseId: deps.settings.warehouseId ?? auth.profileWarehouseId });
  const statements = deps.createStatements(client, { maxRows: 10, allowWrites: false, maxResultBytes: 10_000, resolveWarehouse: sql.resolveWarehouse });
  const checks: DoctorCheck[] = [];

  try {
    const me = await client.get<{ userName?: string; displayName?: string }>("/api/2.0/preview/scim/v2/Me");
    checks.push({ name: "Identity", status: "ok", detail: me.userName ?? me.displayName ?? "authenticated" });
  } catch (error) {
    checks.push({ name: "Identity", status: "fail", detail: messageOf(error), next: "Check the credentials of the selected profile or environment." });
  }

  let warehouseId: string;
  try {
    warehouseId = await sql.resolveWarehouse();
    const warehouse = (await sql.listWarehouses()).find((candidate) => candidate.id === warehouseId);
    checks.push({ name: "SQL warehouse", status: "ok", detail: warehouse === undefined ? warehouseId : `${warehouse.id} (${warehouse.name}, ${warehouse.state})` });
  } catch (error) {
    checks.push({ name: "SQL warehouse", status: "fail", detail: messageOf(error), next: "Set DATABRICKS_WAREHOUSE_ID or get CAN USE on a SQL warehouse." });
    for (const name of ["SQL execution", "information_schema", "Lineage system tables", "Result download"]) checks.push({ name, status: "skip", detail: "no SQL warehouse" });
    return checks;
  }

  let sqlExecutionFailed = false;
  try {
    const result = await statements.submit({ statement: "SELECT 1", warehouseId, rowLimit: 1 }, "server");
    checks.push(
      result.state === "SUCCEEDED"
        ? { name: "SQL execution", status: "ok", detail: "SELECT 1 succeeded" }
        : { name: "SQL execution", status: "warn", detail: `SELECT 1 is ${result.state} (warehouse starting?)`, next: "Run dak doctor again in a minute." },
    );
  } catch (error) {
    sqlExecutionFailed = true;
    checks.push({ name: "SQL execution", status: "fail", detail: messageOf(error), next: "Check CAN USE on the warehouse and that it can start." });
  }

  try {
    await probe(statements, "SELECT 1 FROM system.information_schema.tables LIMIT 1", warehouseId);
    checks.push({ name: "information_schema", status: "ok", detail: "system.information_schema is readable" });
  } catch (error) {
    checks.push({ name: "information_schema", status: "warn", detail: messageOf(error), next: "search_metadata and describe_table tags need SELECT on system.information_schema." });
  }

  try {
    await probe(statements, "SELECT 1 FROM system.access.table_lineage LIMIT 1", warehouseId);
    checks.push({ name: "Lineage system tables", status: "ok", detail: "system.access.table_lineage is readable" });
  } catch (error) {
    checks.push({
      name: "Lineage system tables",
      status: "warn",
      detail: messageOf(error),
      next: "describe_table with lineage needs Unity Catalog system tables (system.access) enabled and SELECT on them.",
    });
  }

  checks.push(sqlExecutionFailed ? { name: "Result download", status: "skip", detail: "SQL execution failed" } : await resultDownloadCheck(deps, statements, warehouseId));
  return checks;
}

async function cliCheck(deps: DoctorDependencies): Promise<DoctorCheck> {
  const name = "Databricks CLI";
  try {
    const output = await deps.runCli(["--version"]);
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
    const version = match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
    const recent = version !== undefined && (version[0]! > MIN_CLI[0] || (version[0] === MIN_CLI[0] && (version[1]! > MIN_CLI[1] || (version[1] === MIN_CLI[1] && version[2]! >= MIN_CLI[2]))));
    return recent
      ? { name, status: "ok", detail: output.trim() }
      : { name, status: "warn", detail: `${output.trim()} is older than v${MIN_CLI.join(".")}`, next: "Upgrade the Databricks CLI (needed for OAuth U2M and the official skills)." };
  } catch (error) {
    return {
      name,
      status: "warn",
      detail: (error as { code?: string }).code === "ENOENT" ? "not installed" : messageOf(error),
      next: "Install it if you use OAuth U2M (databricks auth login) or the official Databricks skills.",
    };
  }
}

/**
 * Checks authentication, identity, warehouse, SQL execution, information_schema, lineage system tables, result download,
 * export directory, log storage, the Databricks CLI and the write mode. Remote checks are skipped when an earlier one makes them meaningless.
 */
export async function runDoctor(deps: DoctorDependencies): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let auth: AuthProvider | undefined;
  try {
    auth = await deps.resolveAuth();
    checks.push({ name: "Authentication", status: "ok", detail: `${auth.method} on ${auth.host} (requested profile: ${deps.settings.profile})` });
  } catch (error) {
    checks.push({ name: "Authentication", status: "fail", detail: messageOf(error), next: "See README > Authentication for the manual steps." });
  }

  if (auth === undefined) {
    for (const name of REMOTE_CHECKS) checks.push({ name, status: "skip", detail: "authentication failed" });
  } else {
    checks.push(...(await remoteChecks(deps, auth)));
  }

  const { exportDir } = deps.settings;
  try {
    await deps.ensureExportDir(exportDir);
    checks.push({ name: "Export directory", status: "ok", detail: exportDir });
  } catch (error) {
    checks.push({ name: "Export directory", status: "fail", detail: `${exportDir}: ${messageOf(error)}`, next: "Set DAK_EXPORT_DIR to a writable directory." });
  }

  const logPath = join(deps.settings.storageDir, "logs.db");
  try {
    (await deps.openRepository(logPath)).close();
    checks.push({ name: "Log storage", status: "ok", detail: logPath });
  } catch (error) {
    checks.push({ name: "Log storage", status: "fail", detail: `${logPath}: ${messageOf(error)}`, next: "Set DAK_STORAGE_DIR to a writable directory." });
  }

  checks.push(await cliCheck(deps));
  checks.push(
    deps.settings.allowWrites
      ? { name: "Write mode", status: "warn", detail: "writes enabled (--allow-writes / DAK_ALLOW_WRITES)", next: "Use a principal with read-only grants for agents." }
      : { name: "Write mode", status: "ok", detail: "read-only" },
  );
  return checks;
}

/** Formats the checks as one line each, their next steps indented below, and a summary line. */
export function formatReport(checks: DoctorCheck[]): string {
  const lines = checks.flatMap((check) => {
    const line = `${`[${check.status}]`.padEnd(6)} ${check.name}: ${check.detail}`;
    return check.next === undefined ? [line] : [line, `       -> ${check.next}`];
  });
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  lines.push("", `${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip`);
  return lines.join("\n");
}
