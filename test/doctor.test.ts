import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureWritableDirectory, formatReport, runDoctor, type DoctorDependencies } from "../src/doctor.ts";
import { withLogs } from "./helpers.ts";
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
  exportDir: "C:/tmp/dak/exports",
  exportMaxBytes: 10 * 1024 ** 3,
  logLevel: "info",
};

const auth: AuthProvider = { host: "https://ws", method: "oauth-u2m", profileWarehouseId: undefined, getToken: async () => "t" };

const DOWNLOAD_URL = "https://storage.example.net/chunk0?sig=secret-signature";

function client(failing: { cancelledStatements?: string[];  lineage?: boolean; informationSchema?: boolean; identity?: boolean; exportStatementState?: string; sqlExecution?: boolean } = {}): DatabricksClient {
  return {
    host: "https://ws",
    get: async <T>(path: string) => {
      if (path === "/api/2.0/preview/scim/v2/Me") {
        if (failing.identity) throw new DatabricksApiError(401, "UNAUTHENTICATED", "[UNAUTHENTICATED] bad token");
        return { userName: "alex@example.com" } as T;
      }
      if (path === "/api/2.0/sql/statements/s") {
        return { statement_id: "s", status: { state: failing.exportStatementState ?? "SUCCEEDED" }, result: { external_links: [{ external_link: DOWNLOAD_URL }] } } as T;
      }
      if (path === "/api/2.0/sql/warehouses") return { warehouses: [{ id: "wh1", name: "Serverless Starter", state: "RUNNING", enable_serverless_compute: true }] } as T;
      throw new Error(`unexpected GET ${path}`);
    },
    post: async <T>(path: string, body?: unknown) => {
      if (path.endsWith("/cancel")) {
        failing.cancelledStatements?.push(path);
        return {} as T;
      }
      const statement = (body as { statement: string }).statement;
      if (failing.sqlExecution && statement === "SELECT 1") {
        return { statement_id: "x", status: { state: "FAILED", error: { error_code: "PERMISSION_DENIED", message: "[PERMISSION_DENIED] no" } } } as T;
      }
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

interface Recorder {
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  sleeps: number[];
}

function deps(overrides: Partial<DoctorDependencies> = {}, recorder: Recorder = { fetchCalls: [], sleeps: [] }): DoctorDependencies {
  return {
    settings,
    resolveAuth: async () => auth,
    createClient: () => client(),
    runCli: async () => "Databricks CLI v1.21.0\n",
    openRepository: async () => ({ close: () => undefined }),
    fetch: async (url, init) => {
      recorder.fetchCalls.push({ url, init });
      return new Response("chunk", { status: 200 });
    },
    ensureExportDir: async () => undefined,
    sleep: async (ms) => {
      recorder.sleeps.push(ms);
    },
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
      ["Result download", "ok"],
      ["Export directory", "ok"],
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
  for (const name of ["Identity", "SQL warehouse", "SQL execution", "information_schema", "Lineage system tables", "Result download"]) {
    assert.equal(byName(checks, name)!.status, "skip", name);
  }
  assert.match(byName(checks, "Result download")!.detail, /authentication failed/);
  assert.equal(byName(checks, "Export directory")!.status, "ok");
  assert.equal(byName(checks, "Log storage")!.status, "ok");
});

test("Result download is skipped when no SQL warehouse is available", async () => {
  const base = client();
  const noWarehouse: DatabricksClient = { ...base, get: async <T>(path: string) => (path === "/api/2.0/sql/warehouses" ? ({ warehouses: [] } as T) : base.get<T>(path)) };
  const checks = await runDoctor(deps({ createClient: () => noWarehouse }));
  assert.equal(byName(checks, "SQL warehouse")!.status, "fail");
  assert.equal(byName(checks, "Result download")!.status, "skip");
  assert.match(byName(checks, "Result download")!.detail, /no SQL warehouse/);
});

test("Result download is skipped when SQL execution fails", async () => {
  const checks = await runDoctor(deps({ createClient: () => client({ sqlExecution: true }) }));
  assert.equal(byName(checks, "SQL execution")!.status, "fail");
  assert.equal(byName(checks, "Result download")!.status, "skip");
  assert.match(byName(checks, "Result download")!.detail, /SQL execution failed/);
});

test("Result download submits SELECT 1 as a CSV export and downloads the first link without headers", async () => {
  const recorder: Recorder = { fetchCalls: [], sleeps: [] };
  const bodies: Array<{ disposition?: string; format?: string }> = [];
  const base = client();
  const recording: DatabricksClient = { ...base, post: async <T>(path: string, body?: unknown) => { bodies.push(body as { disposition?: string; format?: string }); return base.post<T>(path, body); } };
  const checks = await runDoctor(deps({ createClient: () => recording }, recorder));
  assert.equal(byName(checks, "Result download")!.status, "ok");
  assert.equal(recorder.fetchCalls.length, 1);
  assert.equal(recorder.fetchCalls[0]!.url, DOWNLOAD_URL);
  assert.equal(recorder.fetchCalls[0]!.init?.headers, undefined);
  assert.equal(recorder.fetchCalls[0]!.init?.signal instanceof AbortSignal, true);
  assert.equal(bodies.some((body) => body.disposition === "EXTERNAL_LINKS" && body.format === "CSV"), true);
});

test("Result download polls with the injected sleep until the statement succeeds", async () => {
  const recorder: Recorder = { fetchCalls: [], sleeps: [] };
  const base = client();
  let polls = 0;
  const slow: DatabricksClient = {
    ...base,
    get: async <T>(path: string) => {
      if (path !== "/api/2.0/sql/statements/s") return base.get<T>(path);
      polls += 1;
      return (polls < 4
        ? { statement_id: "s", status: { state: "RUNNING" } }
        : { statement_id: "s", status: { state: "SUCCEEDED" }, result: { external_links: [{ external_link: DOWNLOAD_URL }] } }) as T;
    },
  };
  const checks = await runDoctor(deps({ createClient: () => slow }, recorder));
  assert.equal(byName(checks, "Result download")!.status, "ok");
  assert.deepEqual(recorder.sleeps, [1000, 2000, 3000]);
});

test("Result download warns with a proxy hint when the download fails, naming only the host", async () => {
  const forbidden = await runDoctor(deps({ fetch: async () => new Response("denied", { status: 403 }) }));
  const check = byName(forbidden, "Result download")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /403/);
  assert.match(check.next ?? "", /proxy|firewall/i);
  assert.match(`${check.detail} ${check.next}`, /storage\.example\.net/);
  assert.doesNotMatch(`${check.detail} ${check.next}`, /secret-signature|chunk0/);

  const broken = await runDoctor(deps({ fetch: async (url) => { throw new Error(`connect failed for ${url}`); } }));
  const brokenCheck = byName(broken, "Result download")!;
  assert.equal(brokenCheck.status, "warn");
  assert.match(brokenCheck.next ?? "", /proxy|firewall/i);
  assert.match(`${brokenCheck.detail} ${brokenCheck.next}`, /storage\.example\.net/);
  assert.doesNotMatch(`${brokenCheck.detail} ${brokenCheck.next}`, /secret-signature|chunk0/);
});

test("Result download warns when the statement does not finish within 60 seconds", async () => {
  const recorder: Recorder = { fetchCalls: [], sleeps: [] };
  const checks = await runDoctor(deps({ createClient: () => client({ exportStatementState: "RUNNING" }) }, recorder));
  const check = byName(checks, "Result download")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /warehouse still starting/);
  assert.match(check.next ?? "", /dak doctor again/);
  assert.equal(recorder.fetchCalls.length, 0);
  const waited = recorder.sleeps.reduce((total, ms) => total + ms, 0);
  assert.equal(waited >= 60_000 && waited < 66_000, true, `waited ${waited} ms`);
  assert.equal(Math.max(...recorder.sleeps), 5000);
});

test("Result download cancels the abandoned statement when the budget runs out and ignores a failing cancel", async () => {
  const cancelled: string[] = [];
  await runDoctor(deps({ createClient: () => client({ exportStatementState: "RUNNING", cancelledStatements: cancelled }) }));
  assert.deepEqual(cancelled, ["/api/2.0/sql/statements/s/cancel"]);

  const base = client({ exportStatementState: "RUNNING" });
  const failingCancel: DatabricksClient = { ...base, post: async <T>(path: string, body?: unknown) => { if (path.endsWith("/cancel")) throw new Error("cancel failed"); return base.post<T>(path, body); } };
  const checks = await runDoctor(deps({ createClient: () => failingCancel }));
  assert.equal(byName(checks, "Result download")!.status, "warn");
  assert.match(byName(checks, "Result download")!.detail, /warehouse still starting/);
});

test("Result download is ok when the body cannot be cancelled, and never shows URLs from error messages", async () => {
  const unreadable = { status: 200, body: { cancel: async () => { throw new Error("stream locked"); } } } as unknown as Response;
  const ok = await runDoctor(deps({ fetch: async () => unreadable }));
  assert.equal(byName(ok, "Result download")!.status, "ok");

  const variants = "connect failed for https://storage.example.net/chunk0?sig=secret-signature and HTTPS://STORAGE.EXAMPLE.NET/chunk0?sig=secret-signature and https%3A%2F%2Fstorage.example.net%2Fchunk0%3Fsig%3Dsecret-signature";
  const broken = await runDoctor(deps({ fetch: async () => { throw new Error(variants); } }));
  const check = byName(broken, "Result download")!;
  assert.equal(check.status, "warn");
  assert.doesNotMatch(`${check.detail} ${check.next}`, /secret-signature|chunk0|https?:\/\/|https?%3A/i);
  assert.match(check.detail, /storage\.example\.net/);
});

test("a failing export directory is a fail with a next step", async () => {
  const checks = await runDoctor(deps({ ensureExportDir: async () => { throw new Error("EACCES: permission denied"); } }));
  const check = byName(checks, "Export directory")!;
  assert.equal(check.status, "fail");
  assert.match(check.detail, /EACCES/);
  assert.equal(check.next, "Set DAK_EXPORT_DIR to a writable directory.");
});

test("the export directory check receives the configured directory", async () => {
  const seen: string[] = [];
  const checks = await runDoctor(deps({ ensureExportDir: async (dir) => { seen.push(dir); } }));
  assert.deepEqual(seen, [settings.exportDir]);
  assert.equal(byName(checks, "Export directory")!.detail, settings.exportDir);
});

test("optional features degrade to warnings, required ones fail", async () => {
  const checks = await runDoctor(deps({ createClient: () => client({ lineage: true, informationSchema: true, identity: true }) }));
  assert.equal(byName(checks, "Identity")!.status, "fail");
  assert.equal(byName(checks, "information_schema")!.status, "warn");
  assert.match(byName(checks, "information_schema")!.next ?? "", /search_metadata/);
  assert.equal(byName(checks, "Lineage system tables")!.status, "warn");
  assert.match(byName(checks, "Lineage system tables")!.next ?? "", /describe_table with lineage/);
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

test("ensureWritableDirectory creates the directory, leaves no probe file and accepts an existing one", async () => {
  await withLogs("stdio", async ({ dir }) => {
    const target = join(dir, "nested", "exports");
    await ensureWritableDirectory(target);
    assert.equal((await stat(target)).isDirectory(), true);
    assert.deepEqual(await readdir(target), []);
    await ensureWritableDirectory(target);
    assert.deepEqual(await readdir(target), []);
  });
});

test("ensureWritableDirectory rejects when the path is a file", async () => {
  await withLogs("stdio", async ({ dir }) => {
    const file = join(dir, "not-a-directory");
    await writeFile(file, "x");
    await assert.rejects(ensureWritableDirectory(file));
  });
});

test("ensureWritableDirectory creates the directory with mode 0700", { skip: process.platform === "win32" }, async () => {
  await withLogs("stdio", async ({ dir }) => {
    const target = join(dir, "private");
    await ensureWritableDirectory(target);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
  });
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
