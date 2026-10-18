import { join } from "node:path";
import type { AuthProvider } from "./auth.ts";
import type { DatabricksClient } from "./client.ts";
import type { Settings } from "./config.ts";
import { createSqlService, type SqlService } from "./sql.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  next?: string;
}

export interface DoctorDependencies {
  settings: Settings;
  resolveAuth(): Promise<AuthProvider>;
  createClient(auth: AuthProvider): DatabricksClient;
  runCli(args: string[]): Promise<string>;
  openRepository(path: string): Promise<{ close(): void }>;
}

const REMOTE_CHECKS = ["Identity", "SQL warehouse", "SQL execution", "information_schema", "Lineage system tables"] as const;
const MIN_CLI = [1, 0, 0] as const;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function probe(sql: SqlService, statement: string, warehouseId: string): Promise<void> {
  await sql.executeSql({ statement, warehouseId, rowLimit: 1 });
}

async function remoteChecks(deps: DoctorDependencies, auth: AuthProvider): Promise<DoctorCheck[]> {
  const client = deps.createClient(auth);
  const sql = createSqlService(client, {
    maxRows: 10,
    allowWrites: false,
    defaultWarehouseId: deps.settings.warehouseId ?? auth.profileWarehouseId,
    maxResultBytes: 10_000,
  });
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
    for (const name of ["SQL execution", "information_schema", "Lineage system tables"]) checks.push({ name, status: "skip", detail: "no SQL warehouse" });
    return checks;
  }

  try {
    const result = await sql.executeSql({ statement: "SELECT 1", warehouseId, rowLimit: 1 });
    checks.push(
      result.state === "SUCCEEDED"
        ? { name: "SQL execution", status: "ok", detail: "SELECT 1 succeeded" }
        : { name: "SQL execution", status: "warn", detail: `SELECT 1 is ${result.state} (warehouse starting?)`, next: "Run dak doctor again in a minute." },
    );
  } catch (error) {
    checks.push({ name: "SQL execution", status: "fail", detail: messageOf(error), next: "Check CAN USE on the warehouse and that it can start." });
  }

  try {
    await probe(sql, "SELECT 1 FROM system.information_schema.tables LIMIT 1", warehouseId);
    checks.push({ name: "information_schema", status: "ok", detail: "system.information_schema is readable" });
  } catch (error) {
    checks.push({ name: "information_schema", status: "warn", detail: messageOf(error), next: "search_metadata and describe_table tags need SELECT on system.information_schema." });
  }

  try {
    await probe(sql, "SELECT 1 FROM system.access.table_lineage LIMIT 1", warehouseId);
    checks.push({ name: "Lineage system tables", status: "ok", detail: "system.access.table_lineage is readable" });
  } catch (error) {
    checks.push({
      name: "Lineage system tables",
      status: "warn",
      detail: messageOf(error),
      next: "table_lineage needs Unity Catalog system tables (system.access) enabled and SELECT on them.",
    });
  }
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

export function formatReport(checks: DoctorCheck[]): string {
  const lines = checks.flatMap((check) => {
    const line = `${`[${check.status}]`.padEnd(6)} ${check.name}: ${check.detail}`;
    return check.next === undefined ? [line] : [line, `       -> ${check.next}`];
  });
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  lines.push("", `${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip`);
  return lines.join("\n");
}
