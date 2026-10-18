import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, runDoctor, type DoctorDependencies } from "../src/doctor.ts";
import type { DatabricksClient } from "../src/client.ts";
import { DatabricksApiError } from "../src/client.ts";
import { AuthError } from "../src/errors.ts";
import type { AuthProvider } from "../src/auth.ts";
import type { Settings } from "../src/config.ts";

const settings: Settings = {
  profile: "dev",
  explicitProfile: true,
  warehouseId: undefined,
  allowWrites: false,
  maxRows: 1000,
  transport: "stdio",
  httpHost: "127.0.0.1",
  httpPort: 8765,
  httpToken: undefined,
  storageDir: "C:/tmp/dak",
  logLevel: "info",
};

const auth: AuthProvider = { host: "https://ws", method: "oauth-u2m", profileWarehouseId: undefined, getToken: async () => "t" };

function client(failing: { lineage?: boolean; informationSchema?: boolean; identity?: boolean } = {}): DatabricksClient {
  return {
    host: "https://ws",
    get: async <T>(path: string) => {
      if (path === "/api/2.0/preview/scim/v2/Me") {
        if (failing.identity) throw new DatabricksApiError(401, "UNAUTHENTICATED", "[UNAUTHENTICATED] bad token");
        return { userName: "alex@example.com" } as T;
      }
      if (path === "/api/2.0/sql/warehouses") return { warehouses: [{ id: "wh1", name: "Serverless Starter", state: "RUNNING", enable_serverless_compute: true }] } as T;
      throw new Error(`unexpected GET ${path}`);
    },
    post: async <T>(_path: string, body?: unknown) => {
      const statement = (body as { statement: string }).statement;
      if (statement.includes("table_lineage") && failing.lineage) {
        return { statement_id: "x", status: { state: "FAILED", error: { error_code: "BAD_REQUEST", message: "[TABLE_OR_VIEW_NOT_FOUND] system.access.table_lineage" } } } as T;
      }
      if (statement.includes("information_schema") && failing.informationSchema) {
        return { statement_id: "x", status: { state: "FAILED", error: { error_code: "BAD_REQUEST", message: "[PERMISSION_DENIED] no" } } } as T;
      }
      return { statement_id: "s", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [{ name: "x", type_text: "INT" }] }, total_row_count: 1 }, result: { data_array: [["1"]] } } as T;
    },
  };
}

function deps(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    settings,
    resolveAuth: async () => auth,
    createClient: () => client(),
    runCli: async () => "Databricks CLI v1.21.0\n",
    openRepository: async () => ({ close: () => undefined }),
    ...overrides,
  };
}

const byName = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) => checks.find((check) => check.name === name);

test("all checks pass on a healthy workspace", async () => {
  const checks = await runDoctor(deps());
  assert.deepEqual(
    checks.map((check) => [check.name, check.status]),
    [
      ["Authentication", "ok"],
      ["Identity", "ok"],
      ["SQL warehouse", "ok"],
      ["SQL execution", "ok"],
      ["information_schema", "ok"],
      ["Lineage system tables", "ok"],
      ["Log storage", "ok"],
      ["Databricks CLI", "ok"],
      ["Write mode", "ok"],
    ],
  );
  assert.match(byName(checks, "Authentication")!.detail, /oauth-u2m.*https:\/\/ws.*dev/);
  assert.match(byName(checks, "Identity")!.detail, /alex@example.com/);
  assert.match(byName(checks, "SQL warehouse")!.detail, /wh1.*Serverless Starter.*RUNNING/);
});

test("authentication failure fails and skips the remote checks with a next step", async () => {
  const checks = await runDoctor(deps({ resolveAuth: async () => { throw new AuthError("No Databricks credentials found. Run `databricks auth login`"); } }));
  assert.equal(byName(checks, "Authentication")!.status, "fail");
  assert.match(byName(checks, "Authentication")!.detail, /databricks auth login/);
  for (const name of ["Identity", "SQL warehouse", "SQL execution", "information_schema", "Lineage system tables"]) {
    assert.equal(byName(checks, name)!.status, "skip", name);
  }
  assert.equal(byName(checks, "Log storage")!.status, "ok");
});

test("optional features degrade to warnings, required ones fail", async () => {
  const checks = await runDoctor(deps({ createClient: () => client({ lineage: true, informationSchema: true, identity: true }) }));
  assert.equal(byName(checks, "Identity")!.status, "fail");
  assert.equal(byName(checks, "information_schema")!.status, "warn");
  assert.match(byName(checks, "information_schema")!.next ?? "", /search_metadata/);
  assert.equal(byName(checks, "Lineage system tables")!.status, "warn");
  assert.match(byName(checks, "Lineage system tables")!.next ?? "", /table_lineage/);
});

test("old or missing CLI, broken storage and write mode are reported", async () => {
  const old = await runDoctor(deps({ runCli: async () => "Databricks CLI v0.287.0" }));
  assert.equal(byName(old, "Databricks CLI")!.status, "warn");
  const missing = await runDoctor(deps({ runCli: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }));
  assert.equal(byName(missing, "Databricks CLI")!.status, "warn");
  const storage = await runDoctor(deps({ openRepository: async () => { throw new Error("EACCES"); } }));
  assert.equal(byName(storage, "Log storage")!.status, "fail");
  const writes = await runDoctor(deps({ settings: { ...settings, allowWrites: true } }));
  assert.equal(byName(writes, "Write mode")!.status, "warn");
});

test("formatReport prints one line per check and a summary", async () => {
  const report = formatReport([
    { name: "Authentication", status: "ok", detail: "pat on https://ws" },
    { name: "Lineage system tables", status: "warn", detail: "not available", next: "enable system tables" },
  ]);
  assert.match(report, /^\[ok\]\s+Authentication: pat on https:\/\/ws$/m);
  assert.match(report, /^\[warn\]\s+Lineage system tables: not available$/m);
  assert.match(report, /^\s+-> enable system tables$/m);
  assert.match(report, /1 ok, 1 warn, 0 fail, 0 skip/);
});
