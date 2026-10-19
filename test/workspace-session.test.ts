import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AuthProvider } from "../src/auth.ts";
import type { DatabricksClient, QueryValue } from "../src/client.ts";
import { AuthError } from "../src/errors.ts";
import { ReadOnlyViolationError } from "../src/statements.ts";
import { connectWorkspace, createWorkspaceSession, type WorkspaceAdapters, type WorkspaceLimits } from "../src/workspace-session.ts";
import { withLogs } from "./helpers.ts";

const limits: WorkspaceLimits = { maxRows: 50, allowWrites: false, maxResultBytes: 100_000 };

const auth: AuthProvider = { host: "https://ws", method: "pat", profileWarehouseId: undefined, getToken: async () => "t" };

const succeeded = { statement_id: "st1", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [{ name: "n", type_text: "INT", position: 0 }] }, total_row_count: 1 }, result: { data_array: [["1"]] } };

/** Fake workspace REST API: records every request and keeps one export statement running forever. */
function fakeWorkspace() {
  const calls: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];
  const respond = (method: "GET" | "POST", path: string, body?: unknown): unknown => {
    calls.push({ method, path, body });
    if (path === "/api/2.0/sql/warehouses") return { warehouses: [{ id: "wh-auto", name: "Auto", state: "RUNNING", enable_serverless_compute: true }] };
    if (method === "GET" && path === "/api/2.0/sql/statements/st-export") return { statement_id: "st-export", status: { state: "RUNNING" } };
    if (method === "POST" && path === "/api/2.0/sql/statements") {
      return (body as { disposition: string }).disposition === "EXTERNAL_LINKS" ? { statement_id: "st-export", status: { state: "PENDING" } } : succeeded;
    }
    if (method === "POST" && path.endsWith("/cancel")) return {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>(path: string, _query?: Record<string, QueryValue>) => respond("GET", path) as T,
    post: async <T>(path: string, body?: unknown) => respond("POST", path, body) as T,
  };
  return { client, calls };
}

/** Adapters whose credential resolution fails for the first `failures` attempts. */
function adapters(workspace = fakeWorkspace(), failures = 0, provider: AuthProvider = auth) {
  const state = { resolutions: 0, clients: 0, observers: undefined as Parameters<WorkspaceAdapters["createClient"]>[1] | undefined, onRefresh: undefined as Parameters<WorkspaceAdapters["resolveAuth"]>[0] };
  const value: WorkspaceAdapters = {
    resolveAuth: async (onRefresh) => {
      state.resolutions++;
      state.onRefresh = onRefresh;
      if (state.resolutions <= failures) throw new AuthError("No Databricks credentials found. Run `databricks auth login`");
      return provider;
    },
    createClient: (_auth, observers) => {
      state.clients++;
      state.observers = observers;
      return workspace.client;
    },
    fetch: async () => new Response("unused"),
    sleep: () => new Promise<void>(() => undefined),
  };
  return { adapters: value, state, workspace };
}

const sessionOptions = (dir: string, logs: Parameters<typeof createWorkspaceSession>[1]["logs"]) => ({ limits, exportDir: join(dir, "exports"), logs });

test("a session resolves no credentials until the workspace is requested, and closing it does not either", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, state } = adapters();
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    await session.close();
    assert.equal(state.resolutions, 0);
    assert.equal(state.clients, 0);
  });
});

test("a failed resolution fails the call, is retried on the next one without a new session, and a success is reused", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, state } = adapters(undefined, 1);
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    await assert.rejects(session.workspace(), (error: unknown) => error instanceof AuthError && /databricks auth login/.test(error.message));
    const first = await session.workspace();
    const second = await session.workspace();
    assert.equal(first, second);
    assert.equal(state.resolutions, 2);
    assert.equal(state.clients, 1);
  });
});

test("concurrent first calls resolve the credentials once", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, state } = adapters();
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    const [first, second] = await Promise.all([session.workspace(), session.workspace()]);
    assert.equal(first, second);
    assert.equal(state.resolutions, 1);
  });
});

test("closing after a failed resolution does not resolve credentials again", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, state } = adapters(undefined, 1);
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    await assert.rejects(session.workspace());
    await session.close();
    assert.equal(state.resolutions, 1);
  });
});

test("closing cancels a running export together with its Databricks statement", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, workspace } = adapters();
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    const { exports } = await session.workspace();
    const started = await exports.start({ statement: { statement: "SELECT 1" }, format: "csv" });
    assert.equal(started.status, "PENDING");
    await session.close();
    assert.deepEqual(
      workspace.calls.filter((call) => call.path.endsWith("/cancel")).map((call) => call.path),
      ["/api/2.0/sql/statements/st-export/cancel"],
    );
    assert.equal((await exports.get("st-export"))?.status, "CANCELED");
  });
});

test("the workspace limits reach the statement lifecycle", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, workspace } = adapters();
    const { statements } = await createWorkspaceSession(fake, sessionOptions(dir, logs)).workspace();
    await statements.submit({ statement: "SHOW TABLES", rowLimit: 1000 });
    assert.equal((workspace.calls.find((call) => call.method === "POST")?.body as { row_limit: number }).row_limit, 50);
    await assert.rejects(statements.submit({ statement: "SELECT 1; DROP TABLE t" }), ReadOnlyViolationError);
  });
});

test("the configured warehouse wins over the profile's, which wins over the automatic choice", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const profile = adapters(undefined, 0, { ...auth, profileWarehouseId: "wh-profile" });
    const fromProfile = await createWorkspaceSession(profile.adapters, sessionOptions(dir, logs)).workspace();
    assert.equal(await fromProfile.warehouses.resolve(), "wh-profile");

    const configured = adapters(undefined, 0, { ...auth, profileWarehouseId: "wh-profile" });
    const fromSettings = await createWorkspaceSession(configured.adapters, { ...sessionOptions(dir, logs), warehouseId: "wh-settings" }).workspace();
    assert.equal(await fromSettings.warehouses.resolve(), "wh-settings");

    const automatic = adapters();
    const fromListing = await createWorkspaceSession(automatic.adapters, sessionOptions(dir, logs)).workspace();
    assert.equal(await fromListing.warehouses.resolve(), "wh-auto");
  });
});

test("the credentials, the warehouse choice and the diagnostics of a call reach the log through the session's one scope", async () => {
  await withLogs("stdio", async ({ logs, repository, dir }) => {
    const { adapters: fake } = adapters();
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    const { statements } = await session.workspace();
    await session.scope.run({ toolName: "execute_sql" }, async () => {
      await statements.submit({ statement: "SELECT 1" });
      await statements.submit({ statement: "SELECT 2" });
    }, { message: "Tool call completed" });

    logs.flush();
    const lifecycle = repository.executionDetail(logs.lifecycle.executionId)?.logs ?? [];
    assert.deepEqual(lifecycle.filter((entry) => entry.message === "Databricks credentials resolved").map((entry) => entry.metadata), [{ host: "https://ws", method: "pat" }]);

    const execution = repository.recentExecutions(50).find((candidate) => candidate.toolName === "execute_sql");
    const entries = repository.executionDetail(execution!.executionId)?.logs ?? [];
    assert.equal(entries.filter((entry) => entry.message === "Warehouse chosen automatically").length, 1);
    assert.equal(entries.find((entry) => entry.message === "Warehouse chosen automatically")?.metadata?.warehouseId, "wh-auto");
    assert.equal(typeof entries.find((entry) => entry.message === "Tool call completed")?.metadata?.checkMs, "number");
  });
});

test("the client observers and the token refresh hook are connected to the log of the current execution", async () => {
  await withLogs("stdio", async ({ logs, repository, dir }) => {
    const { adapters: fake, state } = adapters();
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    await session.workspace();
    await session.scope.run({ toolName: "t" }, async () => {
      state.observers?.onRetry?.({ method: "GET", path: "/api/x", attempt: 0, delayMs: 10, status: 429 });
    });
    logs.flush();
    const tool = repository.recentExecutions(50).find((candidate) => candidate.toolName === "t");
    const messages = (repository.executionDetail(tool!.executionId)?.logs ?? []).map((entry) => entry.message);
    assert.deepEqual(messages, ["Databricks request retried"]);
    assert.equal(typeof state.onRefresh, "function");
    const lifecycle = repository.executionDetail(logs.lifecycle.executionId)?.logs.map((entry) => entry.message) ?? [];
    assert.equal(lifecycle.includes("Databricks credentials resolved"), true);
  });
});

test("connecting without a log service resolves the credentials and builds the modules without hooks", async () => {
  const { adapters: fake, state } = adapters();
  const connection = await connectWorkspace(fake, { limits: { maxRows: 10, allowWrites: false, maxResultBytes: 10_000 } });
  assert.equal(connection.auth, auth);
  assert.equal(connection.client.host, "https://ws");
  assert.deepEqual(state.observers, {});
  assert.equal(state.onRefresh, undefined);
  assert.equal(await connection.warehouses.resolve(), "wh-auto");
  const result = await connection.statements.submitServerSql({ statement: "SELECT 1", rowLimit: 1 });
  assert.equal(result.state, "SUCCEEDED");
});

test("connecting fails with the authentication error and keeps nothing", async () => {
  const { adapters: fake } = adapters(undefined, 1);
  await assert.rejects(connectWorkspace(fake, { limits }), AuthError);
});
