import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuthProvider } from "../src/auth.ts";
import { loadDatabaseSync } from "../src/sqlite.ts";
import type { DatabricksClient, QueryValue } from "../src/client.ts";
import { AuthError, DakError } from "../src/errors.ts";
import { ReadOnlyViolationError } from "../src/statements.ts";
import {
  connectWorkspace,
  createWorkspaceSession,
  type WorkspaceAdapters,
  type WorkspaceLimits,
} from "../src/workspace-session.ts";
import { withLogs } from "./helpers.ts";

const limits: WorkspaceLimits = { maxRows: 50, allowWrites: false, maxResultBytes: 100_000 };

const auth: AuthProvider = {
  host: "https://ws",
  method: "pat",
  profileWarehouseId: undefined,
  cacheIdentity: "test-identity",
  getToken: async () => "t",
};

const succeeded = {
  statement_id: "st1",
  status: { state: "SUCCEEDED" },
  manifest: { schema: { columns: [{ name: "n", type_text: "INT", position: 0 }] }, total_row_count: 1 },
  result: { data_array: [["1"]] },
};

/** Fake workspace REST API: records every request and keeps one export statement running forever. */
function fakeWorkspace() {
  const calls: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];
  const respond = (method: "GET" | "POST", path: string, body?: unknown): unknown => {
    calls.push({ method, path, body });
    if (path === "/api/2.0/sql/warehouses")
      return { warehouses: [{ id: "wh-auto", name: "Auto", state: "RUNNING", enable_serverless_compute: true }] };
    if (method === "GET" && path === "/api/2.0/sql/statements/st-export")
      return { statement_id: "st-export", status: { state: "RUNNING" } };
    if (method === "POST" && path === "/api/2.0/sql/statements") {
      return (body as { disposition: string }).disposition === "EXTERNAL_LINKS"
        ? { statement_id: "st-export", status: { state: "PENDING" } }
        : succeeded;
    }
    if (method === "GET" && path === "/api/2.1/unity-catalog/catalogs") return { catalogs: [{ name: "main" }] };
    if (method === "GET" && path === "/api/2.1/unity-catalog/tables/main.s.t")
      return { full_name: "main.s.t", columns: [] };
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
  const state = {
    resolutions: 0,
    clients: 0,
    observers: undefined as Parameters<WorkspaceAdapters["createClient"]>[1] | undefined,
    onRefresh: undefined as Parameters<WorkspaceAdapters["resolveAuth"]>[0],
  };
  const value: WorkspaceAdapters = {
    resolveAuth: async (onRefresh) => {
      state.resolutions++;
      state.onRefresh = onRefresh;
      if (state.resolutions <= failures)
        throw new AuthError("No Databricks credentials found. Run `databricks auth login`");
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

const sessionOptions = (dir: string, logs: Parameters<typeof createWorkspaceSession>[1]["logs"]) => ({
  limits,
  exportDir: join(dir, "exports"),
  logs,
});

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
    await assert.rejects(
      session.workspace(),
      (error: unknown) => error instanceof AuthError && /databricks auth login/.test(error.message),
    );
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

test("closing while the first workspace is being built waits for it, and no export can start on it afterwards", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, state, workspace } = adapters();
    let release: () => void = () => undefined;
    const slowCredentials = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = createWorkspaceSession(
      {
        ...fake,
        resolveAuth: async (onRefresh) => {
          await slowCredentials;
          return fake.resolveAuth(onRefresh);
        },
      },
      sessionOptions(dir, logs),
    );

    const building = session.workspace();
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, false, "close waits for the pending build");

    release();
    const { exports } = await building;
    await closing;
    await assert.rejects(
      exports.start({ statement: { statement: "SELECT 1" }, format: "csv" }),
      (error: unknown) => error instanceof DakError && /shutting down/.test(error.message),
    );
    assert.equal(workspace.calls.filter((call) => call.method === "POST").length, 0);
    await assert.rejects(
      session.workspace(),
      (error: unknown) => error instanceof DakError && /shutting down/.test(error.message),
    );
    assert.equal(state.resolutions, 1);
  });
});

test("closing while the first build fails does not retry it and refuses later calls", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, state } = adapters(undefined, 1);
    const session = createWorkspaceSession(fake, sessionOptions(dir, logs));
    const building = session.workspace();
    const rejected = assert.rejects(building, AuthError);
    await session.close();
    await rejected;
    await assert.rejects(session.workspace(), DakError);
    assert.equal(state.resolutions, 1);
  });
});

test("the workspace limits reach the statement lifecycle", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake, workspace } = adapters();
    const { statements } = await createWorkspaceSession(fake, sessionOptions(dir, logs)).workspace();
    await statements.submit({ statement: "SHOW TABLES", rowLimit: 1000 });
    const submitted = workspace.calls.find((call) => call.method === "POST")?.body as { row_limit: number } | undefined;
    assert.equal(submitted?.row_limit, 50);
    await assert.rejects(statements.submit({ statement: "SELECT 1; DROP TABLE t" }), ReadOnlyViolationError);
  });
});

test("the configured warehouse wins over the profile's, which wins over the automatic choice", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const profile = adapters(undefined, 0, { ...auth, profileWarehouseId: "wh-profile" });
    const fromProfile = await createWorkspaceSession(profile.adapters, sessionOptions(dir, logs)).workspace();
    assert.equal(await fromProfile.warehouses.resolve(), "wh-profile");

    const configured = adapters(undefined, 0, { ...auth, profileWarehouseId: "wh-profile" });
    const fromSettings = await createWorkspaceSession(configured.adapters, {
      ...sessionOptions(dir, logs),
      warehouseId: "wh-settings",
    }).workspace();
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
    await session.scope.run(
      { toolName: "execute_sql" },
      async () => {
        await statements.submit({ statement: "SELECT 1" });
        await statements.submit({ statement: "SELECT 2" });
      },
      { message: "Tool call completed" },
    );

    logs.flush();
    const lifecycle = repository.executionDetail(logs.lifecycle.executionId)?.logs ?? [];
    assert.deepEqual(
      lifecycle.filter((entry) => entry.message === "Databricks credentials resolved").map((entry) => entry.metadata),
      [{ host: "https://ws", method: "pat" }],
    );

    const execution = repository.recentExecutions(50).find((candidate) => candidate.toolName === "execute_sql");
    const entries = repository.executionDetail(execution!.executionId)?.logs ?? [];
    assert.equal(entries.filter((entry) => entry.message === "Warehouse chosen automatically").length, 1);
    assert.equal(
      entries.find((entry) => entry.message === "Warehouse chosen automatically")?.metadata?.warehouseId,
      "wh-auto",
    );
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
  const connection = await connectWorkspace(fake, {
    limits: { maxRows: 10, allowWrites: false, maxResultBytes: 10_000 },
  });
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

const cacheOptions = (dir: string, ttlSeconds: number) => ({ path: join(dir, "cache.db"), ttlSeconds });
const tableRequests = (calls: Array<{ path: string }>) => calls.filter((call) => call.path.includes("/tables/")).length;

test("the metadata cache is shared across sessions of one identity and its status reaches the final log entry", async () => {
  await withLogs("stdio", async ({ logs, repository, dir }) => {
    const options = { ...sessionOptions(dir, logs), cache: cacheOptions(dir, 3600) };
    const first = adapters();
    const firstSession = createWorkspaceSession(first.adapters, options);
    const describe = async (session: ReturnType<typeof createWorkspaceSession>, toolName: string) =>
      session.scope.run({ toolName }, async () => (await session.workspace()).metadata.describeTable("main.s.t"), {
        message: "Tool call completed",
      });
    assert.equal((await describe(firstSession, "first_miss")).cache?.status, "miss");
    assert.equal((await describe(firstSession, "first_hit")).cache?.status, "hit");
    await firstSession.close();

    const second = adapters();
    const secondSession = createWorkspaceSession(second.adapters, options);
    assert.equal((await describe(secondSession, "second_hit")).cache?.status, "hit");
    await secondSession.close();
    assert.equal(tableRequests(first.workspace.calls) + tableRequests(second.workspace.calls), 1);

    logs.flush();
    const statusOf = (toolName: string) => {
      const execution = repository.recentExecutions(50).find((candidate) => candidate.toolName === toolName);
      const entries = repository.executionDetail(execution?.executionId ?? "")?.logs ?? [];
      return entries.find((entry) => entry.message === "Tool call completed")?.metadata?.cacheStatus;
    };
    assert.equal(statusOf("first_miss"), "miss");
    assert.equal(statusOf("first_hit"), "hit");
    assert.equal(statusOf("second_hit"), "hit");
  });
});

test("a cache that fails is a warn in the log and a bypassed answer, never a tool error", async () => {
  await withLogs("stdio", async ({ logs, repository, dir }) => {
    const options = { ...sessionOptions(dir, logs), cache: cacheOptions(dir, 3600) };
    const session = createWorkspaceSession(adapters().adapters, options);
    const describe = (toolName: string) =>
      session.scope.run({ toolName }, async () => (await session.workspace()).metadata.describeTable("main.s.t"), {
        message: "Tool call completed",
      });
    assert.equal((await describe("healthy")).cache?.status, "miss");
    const Database = await loadDatabaseSync();
    const other = new Database(join(dir, "cache.db"));
    other.exec("DROP TABLE cache_entries");
    other.close();
    assert.equal((await describe("damaged")).cache?.status, "bypassed");
    await session.close();

    logs.flush();
    const execution = repository.recentExecutions(50).find((candidate) => candidate.toolName === "damaged");
    assert.equal(execution?.status, "completed");
    const entries = repository.executionDetail(execution?.executionId ?? "")?.logs ?? [];
    assert.deepEqual(
      entries.filter((entry) => entry.level === "warn").map((entry) => entry.message),
      ["Metadata cache cannot be read; answering from Databricks"],
    );
    assert.equal(entries.find((entry) => entry.message === "Tool call completed")?.metadata?.cacheStatus, "bypassed");
  });
});

test("list_objects reports its cache status on the final log entry", async () => {
  await withLogs("stdio", async ({ logs, repository, dir }) => {
    const session = createWorkspaceSession(adapters().adapters, {
      ...sessionOptions(dir, logs),
      cache: cacheOptions(dir, 3600),
    });
    for (const toolName of ["list_miss", "list_hit"]) {
      await session.scope.run({ toolName }, async () => (await session.workspace()).metadata.listObjects({}), {
        message: "Tool call completed",
      });
    }
    await session.close();
    logs.flush();
    const statusOf = (toolName: string) => {
      const execution = repository.recentExecutions(50).find((candidate) => candidate.toolName === toolName);
      const entries = repository.executionDetail(execution?.executionId ?? "")?.logs ?? [];
      return entries.find((entry) => entry.message === "Tool call completed")?.metadata?.cacheStatus;
    };
    assert.equal(statusOf("list_miss"), "miss");
    assert.equal(statusOf("list_hit"), "hit");
  });
});

test("a session with the cache disabled opens no cache.db and its answers carry no cache field", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const { adapters: fake } = adapters();
    const session = createWorkspaceSession(fake, { ...sessionOptions(dir, logs), cache: cacheOptions(dir, 0) });
    const description = await (await session.workspace()).metadata.describeTable("main.s.t");
    assert.equal(description.cache, undefined);
    await session.close();
    await assert.rejects(stat(join(dir, "cache.db")), { code: "ENOENT" });
  });
});

test("sessions of different cache identities keep separate entries on the same file", async () => {
  await withLogs("stdio", async ({ logs, dir }) => {
    const options = { ...sessionOptions(dir, logs), cache: cacheOptions(dir, 3600) };
    const other = adapters(undefined, 0, { ...auth, cacheIdentity: "another-identity" });
    const first = createWorkspaceSession(adapters().adapters, options);
    const second = createWorkspaceSession(other.adapters, options);
    assert.equal((await (await first.workspace()).metadata.describeTable("main.s.t")).cache?.status, "miss");
    assert.equal((await (await second.workspace()).metadata.describeTable("main.s.t")).cache?.status, "miss");
    await first.close();
    await second.close();
  });
});
