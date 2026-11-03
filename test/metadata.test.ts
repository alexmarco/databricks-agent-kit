import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createMetadataService } from "../src/metadata.ts";
import { checkMetadataCache, openMetadataCache, type MetadataCache } from "../src/metadata-cache.ts";
import { loadDatabaseSync } from "../src/sqlite.ts";
import type { DatabricksClient, QueryValue } from "../src/client.ts";
import { InvalidArgumentError } from "../src/errors.ts";
import type { ExecuteSqlRequest, StatementLifecycle, StatementResult } from "../src/statements.ts";
import { SqlError } from "../src/statements.ts";

function fakeClient(routes: Record<string, unknown[] | unknown>) {
  const calls: Array<{ path: string; query: Record<string, QueryValue> | undefined }> = [];
  const pages = new Map<string, unknown[]>();
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>(path: string, query?: Record<string, QueryValue>) => {
      calls.push({ path, query });
      const route = routes[path];
      if (Array.isArray(route)) {
        const queue = pages.get(path) ?? [...route];
        pages.set(path, queue);
        return queue.shift() as T;
      }
      return route as T;
    },
    post: async <T>() => ({}) as T,
  };
  return { client, calls };
}

/** Only `query` exists: a call to any other statement lifecycle method fails the test. */
function fakeStatements(respond: (request: ExecuteSqlRequest) => StatementResult | Error) {
  const requests: ExecuteSqlRequest[] = [];
  const statements = {
    query: async (request: ExecuteSqlRequest) => {
      requests.push(request);
      const result = respond(request);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as StatementLifecycle;
  return { statements, requests };
}

const rowsResult = (columns: string[], rows: Array<Array<string | null>>): StatementResult => ({
  statementId: "s",
  state: "SUCCEEDED",
  columns: columns.map((name) => ({ name, type: "STRING" })),
  rows,
  rowCount: rows.length,
  truncated: false,
});

const noStatements = fakeStatements(() => new Error("unexpected SQL")).statements;

test("the service exposes only listObjects, describeTable and searchMetadata", () => {
  const metadata = createMetadataService(fakeClient({}).client, noStatements);
  assert.deepEqual(Object.keys(metadata).sort(), ["describeTable", "listObjects", "searchMetadata"]);
});

test("listObjects without arguments lists catalogs and follows pagination", async () => {
  const { client, calls } = fakeClient({
    "/api/2.1/unity-catalog/catalogs": [
      { catalogs: [{ name: "main", comment: "Main" }], next_page_token: "p2" },
      { catalogs: [{ name: "samples" }] },
    ],
  });
  const listing = await createMetadataService(client, noStatements).listObjects({});
  assert.deepEqual(listing, {
    level: "catalogs",
    items: [
      { name: "main", comment: "Main" },
      { name: "samples", comment: undefined },
    ],
    truncated: false,
  });
  assert.equal(calls[1]!.query?.page_token, "p2");
});

test("listObjects with a catalog lists schemas", async () => {
  const { client, calls } = fakeClient({
    "/api/2.1/unity-catalog/schemas": { schemas: [{ name: "default", comment: "d" }] },
  });
  const listing = await createMetadataService(client, noStatements).listObjects({ catalog: "main" });
  assert.deepEqual(listing, { level: "schemas", items: [{ name: "default", comment: "d" }], truncated: false });
  assert.equal(calls[0]!.query?.catalog_name, "main");
});

const tablesRoute = {
  "/api/2.1/unity-catalog/tables": {
    tables: [
      { name: "orders", table_type: "MANAGED", comment: "Orders" },
      { name: "customers", table_type: "VIEW" },
      { name: "order_items", table_type: "EXTERNAL" },
    ],
  },
};

test("listObjects with catalog and schema lists tables and filters by pattern", async () => {
  const { client, calls } = fakeClient(tablesRoute);
  const listing = await createMetadataService(client, noStatements).listObjects({
    catalog: "main",
    schema: "default",
    pattern: "ORDER*",
  });
  assert.equal(listing.level, "tables");
  assert.deepEqual(
    listing.items.map((item) => item.name),
    ["orders", "order_items"],
  );
  assert.deepEqual(listing.items[0], { name: "orders", type: "MANAGED", comment: "Orders" });
  assert.equal(calls[0]!.query?.schema_name, "default");
  assert.equal(calls[0]!.query?.omit_columns, true);
});

test("listObjects cuts at the limit and reports truncation", async () => {
  const { client } = fakeClient(tablesRoute);
  const listing = await createMetadataService(client, noStatements).listObjects({
    catalog: "main",
    schema: "default",
    limit: 2,
  });
  assert.equal(listing.items.length, 2);
  assert.equal(listing.truncated, true);
});

test("listObjects applies the pattern before the limit", async () => {
  const { client } = fakeClient(tablesRoute);
  const listing = await createMetadataService(client, noStatements).listObjects({
    catalog: "main",
    schema: "default",
    pattern: "order*",
    limit: 2,
  });
  assert.deepEqual(
    listing.items.map((item) => item.name),
    ["orders", "order_items"],
  );
  assert.equal(listing.truncated, false);
});

test("listObjects defaults the limit to 100 and caps it at 500", async () => {
  const catalogs = Array.from({ length: 600 }, (_, index) => ({ name: `c${index}` }));
  const { client } = fakeClient({ "/api/2.1/unity-catalog/catalogs": { catalogs } });
  const metadata = createMetadataService(client, noStatements);
  const byDefault = await metadata.listObjects({});
  assert.equal(byDefault.items.length, 100);
  assert.equal(byDefault.truncated, true);
  const capped = await metadata.listObjects({ limit: 5000 });
  assert.equal(capped.items.length, 500);
  assert.equal(capped.truncated, true);
});

test("listObjects rejects a schema without a catalog", async () => {
  await assert.rejects(
    createMetadataService(fakeClient({}).client, noStatements).listObjects({ schema: "s" }),
    InvalidArgumentError,
  );
});

test("describeTable returns columns, constraints, clustering, partitions and audit fields from one REST call", async () => {
  const { client, calls } = fakeClient({
    "/api/2.1/unity-catalog/tables/main.sales.orders": {
      full_name: "main.sales.orders",
      table_type: "MANAGED",
      data_source_format: "DELTA",
      comment: "One row per order",
      owner: "data-team",
      view_definition: "SELECT 1",
      created_at: Date.parse("2026-01-02T03:04:05.000Z"),
      created_by: "creator@example.com",
      updated_at: Date.parse("2026-10-11T12:13:14.000Z"),
      updated_by: "updater@example.com",
      columns: [
        { name: "order_id", type_text: "bigint", nullable: false, comment: "PK" },
        { name: "customer_id", type_text: "bigint", nullable: true },
        { name: "order_date", type_text: "date", nullable: true, partition_index: 0 },
      ],
      table_constraints: [
        { primary_key_constraint: { name: "pk", child_columns: ["order_id"] } },
        {
          foreign_key_constraint: {
            name: "fk",
            child_columns: ["customer_id"],
            parent_table: "main.sales.customers",
            parent_columns: ["id"],
          },
        },
      ],
      properties: { clusteringColumns: '[["customer_id"]]', other: "x" },
    },
  });
  const { statements, requests } = fakeStatements(() => new Error("unexpected SQL"));
  const table = await createMetadataService(client, statements).describeTable("main.sales.orders");
  assert.deepEqual(table, {
    fullName: "main.sales.orders",
    type: "MANAGED",
    format: "DELTA",
    comment: "One row per order",
    owner: "data-team",
    columns: [
      { name: "order_id", type: "bigint", nullable: false, comment: "PK" },
      { name: "customer_id", type: "bigint", nullable: true, comment: undefined },
      { name: "order_date", type: "date", nullable: true, comment: undefined },
    ],
    primaryKey: ["order_id"],
    foreignKeys: [{ columns: ["customer_id"], references: "main.sales.customers", referencedColumns: ["id"] }],
    clusteringColumns: ["customer_id"],
    partitionColumns: ["order_date"],
    createdAt: "2026-01-02T03:04:05.000Z",
    createdBy: "creator@example.com",
    updatedAt: "2026-10-11T12:13:14.000Z",
    updatedBy: "updater@example.com",
  });
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/2.1/unity-catalog/tables/main.sales.orders"],
  );
  assert.equal(requests.length, 0, "no SQL statement is submitted");
});

test("describeTable leaves out the audit fields the API does not return", async () => {
  const { client } = fakeClient({ "/api/2.1/unity-catalog/tables/main.s.t": { full_name: "main.s.t", columns: [] } });
  assert.deepEqual(await createMetadataService(client, noStatements).describeTable("main.s.t"), {
    fullName: "main.s.t",
    columns: [],
  });
});

test("searchMetadata queries information_schema with a parameterized pattern", async () => {
  const { statements, requests } = fakeStatements(() =>
    rowsResult(
      ["kind", "catalog", "schema", "table", "column", "comment"],
      [
        ["table", "main", "sales", "orders", null, "Orders"],
        ["column", "main", "sales", "orders", "order_total", null],
      ],
    ),
  );
  const results = await createMetadataService(fakeClient({}).client, statements).searchMetadata({
    query: "Order",
    catalog: "main",
    limit: 20,
  });
  assert.deepEqual(results, [
    { kind: "table", catalog: "main", schema: "sales", table: "orders", column: null, comment: "Orders" },
    { kind: "column", catalog: "main", schema: "sales", table: "orders", column: "order_total", comment: null },
  ]);
  const request = requests[0]!;
  assert.match(request.statement, /system\.information_schema\.tables/);
  assert.match(request.statement, /system\.information_schema\.columns/);
  assert.match(request.statement, /LIMIT 20/);
  assert.deepEqual(request.parameters, [
    { name: "pattern", value: "%order%" },
    { name: "catalog", value: "main" },
  ]);
  assert.equal(request.rowLimit, 20);
});

test("searchMetadata surfaces a statement that did not finish instead of an empty list", async () => {
  const { statements } = fakeStatements(
    () => new SqlError("Statement did not finish in time (RUNNING); the warehouse may be starting, retry in a moment."),
  );
  await assert.rejects(
    createMetadataService(fakeClient({}).client, statements).searchMetadata({ query: "order" }),
    /did not finish/,
  );
});

const CACHE_START = Date.parse("2026-11-03T10:00:00.000Z");
const MINUTE = 60_000;

interface CacheContext {
  /** Opens the cache of one identity on the shared `cache.db`; every cache is closed at the end of the test. */
  open(options?: { identity?: string; ttlSeconds?: number }): Promise<MetadataCache>;
  clock: { now: number };
  /** Path of the shared `cache.db`. */
  path: string;
  /** Warnings the caches reported, as their messages. */
  warnings: string[];
}

async function withCache(run: (context: CacheContext) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "dak-cache-"));
  const clock = { now: CACHE_START };
  const opened: MetadataCache[] = [];
  const warnings: string[] = [];
  const path = join(dir, "cache.db");
  const open: CacheContext["open"] = async (options = {}) => {
    const cache = await openMetadataCache({
      path,
      warn: (message) => warnings.push(message),
      identity: options.identity ?? "identity-a",
      ttlSeconds: options.ttlSeconds ?? 3600,
      now: () => clock.now,
    });
    opened.push(cache);
    return cache;
  };
  try {
    await run({ open, clock, path, warnings });
  } finally {
    for (const cache of opened) cache.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const cachedTableRoute = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  "/api/2.1/unity-catalog/tables/main.s.t": { full_name: "main.s.t", columns: [], ...extra },
});

test("describeTable with a cache: the first call is a miss and the second a hit that makes no request", async () => {
  await withCache(async ({ open, clock }) => {
    const { client, calls } = fakeClient(cachedTableRoute({ comment: "Orders" }));
    const metadata = createMetadataService(client, noStatements, await open());
    const first = await metadata.describeTable("main.s.t");
    assert.deepEqual(first.cache, { status: "miss", cachedAt: "2026-11-03T10:00:00.000Z" });
    clock.now += 5 * MINUTE;
    const second = await metadata.describeTable("main.s.t");
    assert.deepEqual(second.cache, { status: "hit", cachedAt: "2026-11-03T10:00:00.000Z" });
    assert.equal(calls.length, 1, "the hit makes no request to Databricks");
    assert.deepEqual({ ...second, cache: undefined }, { ...first, cache: undefined });
  });
});

test("describeTable with a cache: after the TTL the entry is reloaded as expired and replaced", async () => {
  await withCache(async ({ open, clock }) => {
    const { client, calls } = fakeClient(cachedTableRoute());
    const metadata = createMetadataService(client, noStatements, await open({ ttlSeconds: 600 }));
    await metadata.describeTable("main.s.t");
    clock.now += 599_000;
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "hit");
    clock.now += 1_000;
    const expired = await metadata.describeTable("main.s.t");
    assert.deepEqual(expired.cache, { status: "expired", cachedAt: "2026-11-03T10:10:00.000Z" });
    assert.equal(calls.length, 2);
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "hit", "the reload replaced the entry");
    assert.equal(calls.length, 2);
  });
});

test("describeTable with a cache: a new TTL applies at once to the entries already stored", async () => {
  await withCache(async ({ open, clock }) => {
    const { client, calls } = fakeClient(cachedTableRoute());
    await createMetadataService(client, noStatements, await open({ ttlSeconds: 86_400 })).describeTable("main.s.t");
    clock.now += 30 * MINUTE;
    const shorter = createMetadataService(client, noStatements, await open({ ttlSeconds: 600 }));
    assert.equal((await shorter.describeTable("main.s.t")).cache?.status, "expired");
    assert.equal(calls.length, 2);
  });
});

test("describeTable with a cache: refresh reloads a fresh entry and replaces it", async () => {
  await withCache(async ({ open, clock }) => {
    const route = cachedTableRoute({ comment: "old" });
    const { client, calls } = fakeClient(route);
    const metadata = createMetadataService(client, noStatements, await open());
    await metadata.describeTable("main.s.t");
    route["/api/2.1/unity-catalog/tables/main.s.t"] = { full_name: "main.s.t", columns: [], comment: "new" };
    clock.now += MINUTE;
    const refreshed = await metadata.describeTable("main.s.t", { refresh: true });
    assert.deepEqual(refreshed.cache, { status: "refreshed", cachedAt: "2026-11-03T10:01:00.000Z" });
    assert.equal(refreshed.comment, "new");
    assert.equal(calls.length, 2);
    const next = await metadata.describeTable("main.s.t");
    assert.equal(next.cache?.status, "hit");
    assert.equal(next.comment, "new", "later lookups see the refreshed answer");
  });
});

test("describeTable with a cache: refresh on a table never cached still loads and stores it", async () => {
  await withCache(async ({ open }) => {
    const { client, calls } = fakeClient(cachedTableRoute());
    const metadata = createMetadataService(client, noStatements, await open());
    assert.equal((await metadata.describeTable("main.s.t", { refresh: true })).cache?.status, "refreshed");
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "hit");
    assert.equal(calls.length, 1);
  });
});

test("the cache counts every reload as changed or unchanged by comparing the values", async () => {
  await withCache(async ({ open, clock }) => {
    const route = cachedTableRoute({ comment: "v1" });
    const cache = await open({ ttlSeconds: 600 });
    const metadata = createMetadataService(fakeClient(route).client, noStatements, cache);
    await metadata.describeTable("main.s.t");
    clock.now += 11 * MINUTE;
    await metadata.describeTable("main.s.t"); // expired, same value
    await metadata.describeTable("main.s.t", { refresh: true }); // refreshed, same value
    route["/api/2.1/unity-catalog/tables/main.s.t"] = { full_name: "main.s.t", columns: [], comment: "v2" };
    await metadata.describeTable("main.s.t", { refresh: true }); // refreshed, new value
    await metadata.describeTable("main.s.t"); // hit
    const entry = cache.entry("table", "main.s.t");
    assert.equal(entry?.misses, 1);
    assert.equal(entry?.expirations, 1);
    assert.equal(entry?.refreshes, 2);
    assert.equal(entry?.hits, 1);
    assert.equal(entry?.reloadsUnchanged, 2);
    assert.equal(entry?.reloadsChanged, 1);
  });
});

test("describeTable with a cache: a table name in another case hits the same entry", async () => {
  await withCache(async ({ open }) => {
    const { client, calls } = fakeClient(cachedTableRoute());
    const metadata = createMetadataService(client, noStatements, await open());
    await metadata.describeTable("main.s.t");
    assert.equal((await metadata.describeTable("MAIN.S.T")).cache?.status, "hit");
    assert.equal((await metadata.describeTable("Main.S.t")).cache?.status, "hit");
    assert.equal(calls.length, 1);
  });
});

test("two cache identities on the same file keep separate entries and counters", async () => {
  await withCache(async ({ open, clock }) => {
    const { client, calls } = fakeClient(cachedTableRoute());
    const first = await open({ identity: "identity-a" });
    const second = await open({ identity: "identity-b" });
    await createMetadataService(client, noStatements, first).describeTable("main.s.t");
    assert.equal(second.entry("table", "main.s.t"), undefined, "the other identity sees nothing");
    clock.now += MINUTE;
    const otherMetadata = createMetadataService(client, noStatements, second);
    assert.equal((await otherMetadata.describeTable("main.s.t")).cache?.status, "miss");
    assert.equal(calls.length, 2, "the other identity had to load it");
    assert.equal((await otherMetadata.describeTable("main.s.t")).cache?.status, "hit");
    assert.equal(first.entry("table", "main.s.t")?.hits, 0);
    assert.equal(second.entry("table", "main.s.t")?.hits, 1);
  });
});

function flakyClient(route: Record<string, unknown>) {
  const state = { failing: true, calls: 0 };
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>(path: string) => {
      state.calls++;
      if (state.failing) throw new Error("[PERMISSION_DENIED] revoked");
      return route[path] as T;
    },
    post: async <T>() => ({}) as T,
  };
  return { client, state };
}

test("describeTable with a cache: a failed load is not stored", async () => {
  await withCache(async ({ open }) => {
    const cache = await open();
    const { client, state } = flakyClient(cachedTableRoute());
    const metadata = createMetadataService(client, noStatements, cache);
    await assert.rejects(metadata.describeTable("main.s.t"), /PERMISSION_DENIED/);
    assert.equal(cache.entry("table", "main.s.t"), undefined);
    state.failing = false;
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "miss", "the table is found once it exists");
  });
});

test("describeTable with a cache: a failed reload returns the error, never the old value", async () => {
  await withCache(async ({ open, clock }) => {
    const { client, state } = flakyClient(cachedTableRoute({ comment: "old" }));
    const metadata = createMetadataService(client, noStatements, await open({ ttlSeconds: 600 }));
    state.failing = false;
    await metadata.describeTable("main.s.t");
    state.failing = true;
    clock.now += 11 * MINUTE;
    await assert.rejects(metadata.describeTable("main.s.t"), /PERMISSION_DENIED/);
    await assert.rejects(metadata.describeTable("main.s.t", { refresh: true }), /PERMISSION_DENIED/);
    state.failing = false;
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "expired");
  });
});

test("cache.db is readable only by its owner", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dak-cache-"));
  const cache = await openMetadataCache({
    path: join(dir, "nested", "cache.db"),
    identity: "identity-a",
    ttlSeconds: 60,
  });
  try {
    assert.equal((await stat(join(dir, "nested", "cache.db"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
  } finally {
    cache.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt cache.db is recreated and the call answers normally", async () => {
  await withCache(async ({ open, path, warnings }) => {
    await writeFile(path, "this is not a SQLite database, just text".repeat(100));
    const { client } = fakeClient(cachedTableRoute());
    const metadata = createMetadataService(client, noStatements, await open());
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "miss");
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "hit");
    assert.equal(warnings.length, 0, "a recreated file is not a failure");
  });
});

test("a cache.db with another schema version is recreated, so its entries are not served", async () => {
  await withCache(async ({ open, path }) => {
    const { client, calls } = fakeClient(cachedTableRoute());
    const first = await open();
    await createMetadataService(client, noStatements, first).describeTable("main.s.t");
    first.close();
    const Database = await loadDatabaseSync();
    const upgraded = new Database(path);
    upgraded.exec("PRAGMA user_version = 99");
    upgraded.close();
    const metadata = createMetadataService(client, noStatements, await open());
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "miss");
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "hit");
    assert.equal(calls.length, 2);
  });
});

/** Breaks the cache file from outside, as a damaged file would. */
async function breakCacheFile(path: string) {
  const Database = await loadDatabaseSync();
  const other = new Database(path);
  other.exec("DROP TABLE cache_entries");
  other.close();
}

test("a cache that fails to read or write answers from Databricks as bypassed, with a warning", async () => {
  await withCache(async ({ open, path, warnings }) => {
    const { client, calls } = fakeClient(cachedTableRoute({ comment: "Orders" }));
    const metadata = createMetadataService(client, noStatements, await open());
    await metadata.describeTable("main.s.t");
    await breakCacheFile(path);
    const answer = await metadata.describeTable("main.s.t");
    assert.equal(answer.cache?.status, "bypassed");
    assert.equal(answer.comment, "Orders", "the answer is the one from Databricks");
    assert.equal(calls.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /cache/i);
  });
});

test("a bypassed answer is not counted in the entry counters", async () => {
  await withCache(async ({ open, path, clock, warnings }) => {
    const cache = await open({ ttlSeconds: 600 });
    const metadata = createMetadataService(fakeClient(cachedTableRoute()).client, noStatements, cache);
    await metadata.describeTable("main.s.t");
    const Database = await loadDatabaseSync();
    const other = new Database(path);
    other.exec("CREATE TRIGGER no_update BEFORE UPDATE ON cache_entries BEGIN SELECT RAISE(ABORT, 'read-only'); END;");
    other.close();
    clock.now += 11 * MINUTE;
    assert.equal(
      (await metadata.describeTable("main.s.t")).cache?.status,
      "bypassed",
      "the entry could be read but not replaced",
    );
    assert.equal(warnings.length, 1);
    const entry = cache.entry("table", "main.s.t");
    assert.equal(entry?.expirations, 0);
    assert.equal(entry?.reloadsUnchanged, 0);
    assert.equal(entry?.misses, 1);
  });
});

test("a cache that fails still returns the error of a failed load", async () => {
  await withCache(async ({ open, path }) => {
    const { client, state } = flakyClient(cachedTableRoute());
    const metadata = createMetadataService(client, noStatements, await open());
    await breakCacheFile(path);
    await assert.rejects(metadata.describeTable("main.s.t"), /PERMISSION_DENIED/);
    state.failing = false;
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "bypassed");
  });
});

const listingRoutes = (
  tables: unknown[] = tablesRoute["/api/2.1/unity-catalog/tables"].tables,
): Record<string, unknown> => ({
  "/api/2.1/unity-catalog/catalogs": { catalogs: [{ name: "main" }, { name: "samples" }] },
  "/api/2.1/unity-catalog/schemas": { schemas: [{ name: "default" }, { name: "sales" }] },
  "/api/2.1/unity-catalog/tables": { tables },
});

test("listObjects with a cache: a second call of the same level makes no request, whatever pattern and limit", async () => {
  await withCache(async ({ open, clock }) => {
    const { client, calls } = fakeClient(listingRoutes());
    const metadata = createMetadataService(client, noStatements, await open());
    const first = await metadata.listObjects({ catalog: "main", schema: "default", pattern: "ORDER*" });
    assert.deepEqual(first.cache, { status: "miss", cachedAt: "2026-11-03T10:00:00.000Z" });
    assert.deepEqual(
      first.items.map((item) => item.name),
      ["orders", "order_items"],
    );
    clock.now += MINUTE;
    const second = await metadata.listObjects({ catalog: "main", schema: "default", pattern: "customers" });
    assert.deepEqual(second.cache, { status: "hit", cachedAt: "2026-11-03T10:00:00.000Z" });
    assert.deepEqual(
      second.items.map((item) => item.name),
      ["customers"],
    );
    const limited = await metadata.listObjects({ catalog: "main", schema: "default", limit: 2 });
    assert.equal(limited.items.length, 2);
    assert.equal(limited.truncated, true, "truncated is computed from the cached listing");
    assert.equal(limited.cache?.status, "hit");
    assert.equal(calls.length, 1, "one entry serves every pattern and limit");
  });
});

test("listObjects with a cache: the three levels have separate entries and names in other case hit them", async () => {
  await withCache(async ({ open }) => {
    const { client, calls } = fakeClient(listingRoutes());
    const metadata = createMetadataService(client, noStatements, await open());
    for (const request of [{}, { catalog: "main" }, { catalog: "main", schema: "default" }]) {
      assert.equal((await metadata.listObjects(request)).cache?.status, "miss", JSON.stringify(request));
    }
    assert.equal(calls.length, 3);
    assert.equal((await metadata.listObjects({})).cache?.status, "hit");
    assert.equal((await metadata.listObjects({ catalog: "MAIN" })).cache?.status, "hit");
    assert.equal((await metadata.listObjects({ catalog: "Main", schema: "DEFAULT" })).cache?.status, "hit");
    assert.equal(calls.length, 3);
  });
});

test("listObjects with a cache: the pages are loaded once and the answer equals the one without a cache", async () => {
  await withCache(async ({ open }) => {
    const pages = () => [
      { catalogs: [{ name: "main", comment: "Main" }], next_page_token: "p2" },
      { catalogs: [{ name: "samples" }] },
    ];
    const cached = fakeClient({ "/api/2.1/unity-catalog/catalogs": pages() });
    const metadata = createMetadataService(cached.client, noStatements, await open());
    await metadata.listObjects({});
    const hit = await metadata.listObjects({});
    assert.equal(cached.calls.length, 2, "two pages, once");
    const uncached = await createMetadataService(
      fakeClient({ "/api/2.1/unity-catalog/catalogs": pages() }).client,
      noStatements,
    ).listObjects({});
    assert.deepEqual(JSON.parse(JSON.stringify({ ...hit, cache: undefined })), JSON.parse(JSON.stringify(uncached)));
  });
});

test("listObjects with a cache: refresh reloads the whole listing and replaces the entry", async () => {
  await withCache(async ({ open, clock }) => {
    const routes = listingRoutes();
    const { client, calls } = fakeClient(routes);
    const metadata = createMetadataService(client, noStatements, await open());
    await metadata.listObjects({ catalog: "main", schema: "default" });
    routes["/api/2.1/unity-catalog/tables"] = { tables: [{ name: "brand_new", table_type: "MANAGED" }] };
    clock.now += MINUTE;
    const refreshed = await metadata.listObjects({ catalog: "main", schema: "default", refresh: true });
    assert.deepEqual(refreshed.cache, { status: "refreshed", cachedAt: "2026-11-03T10:01:00.000Z" });
    assert.deepEqual(
      refreshed.items.map((item) => item.name),
      ["brand_new"],
    );
    const next = await metadata.listObjects({ catalog: "main", schema: "default" });
    assert.equal(next.cache?.status, "hit");
    assert.deepEqual(
      next.items.map((item) => item.name),
      ["brand_new"],
    );
    assert.equal(calls.length, 2);
  });
});

test("listObjects with a cache: expiry, failed loads and a failing cache behave as for describeTable", async () => {
  await withCache(async ({ open, clock, path, warnings }) => {
    const { client, calls } = fakeClient(listingRoutes());
    const metadata = createMetadataService(client, noStatements, await open({ ttlSeconds: 600 }));
    await metadata.listObjects({ catalog: "main" });
    clock.now += 11 * MINUTE;
    assert.equal((await metadata.listObjects({ catalog: "main" })).cache?.status, "expired");
    assert.equal(calls.length, 2);
    await breakCacheFile(path);
    const bypassed = await metadata.listObjects({ catalog: "main" });
    assert.equal(bypassed.cache?.status, "bypassed");
    assert.deepEqual(
      bypassed.items.map((item) => item.name),
      ["default", "sales"],
    );
    assert.equal(warnings.length, 1);
  });
});

test("listObjects with a cache: a failed load is not stored", async () => {
  await withCache(async ({ open }) => {
    const cache = await open();
    const { client, state } = flakyClient(listingRoutes());
    const metadata = createMetadataService(client, noStatements, cache);
    await assert.rejects(metadata.listObjects({ catalog: "main" }), /PERMISSION_DENIED/);
    assert.equal(cache.entry("listing", "main"), undefined);
    state.failing = false;
    assert.equal((await metadata.listObjects({ catalog: "main" })).cache?.status, "miss");
  });
});

test("listObjects still rejects a schema without a catalog when a cache is in use", async () => {
  await withCache(async ({ open }) => {
    const metadata = createMetadataService(fakeClient({}).client, noStatements, await open());
    await assert.rejects(metadata.listObjects({ schema: "s" }), InvalidArgumentError);
  });
});

/** A client whose requests take a known time on the injected clock: 40 ms for a table, 100 ms for the catalogs. */
function timedClient(clock: { now: number }, routes: Record<string, unknown>): DatabricksClient {
  return {
    host: "https://ws",
    get: async <T>(path: string) => {
      clock.now += path.endsWith("/catalogs") ? 100 : 40;
      return routes[path] as T;
    },
    post: async <T>() => ({}) as T,
  };
}

/** table: miss, hit x3, refresh. listing (catalogs): miss, hit x3. One minute passes between calls. */
async function runKnownSequence(metadata: ReturnType<typeof createMetadataService>, clock: { now: number }) {
  const step = () => (clock.now += MINUTE);
  await metadata.describeTable("main.s.t");
  for (let call = 0; call < 3; call++) {
    step();
    await metadata.describeTable("main.s.t");
  }
  step();
  await metadata.describeTable("main.s.t", { refresh: true });
  step();
  await metadata.listObjects({});
  for (let call = 0; call < 3; call++) {
    step();
    await metadata.listObjects({});
  }
}

test("the cache statistics match a known sequence of calls", async () => {
  await withCache(async ({ open, clock }) => {
    const cache = await open();
    const client = timedClient(clock, { ...listingRoutes(), ...cachedTableRoute() });
    await runKnownSequence(createMetadataService(client, noStatements, cache), clock);
    assert.deepEqual(cache.stats(), {
      total: {
        entries: 2,
        hits: 6,
        misses: 2,
        expirations: 0,
        refreshes: 1,
        reloadsChanged: 0,
        reloadsUnchanged: 1,
        hitRatio: 0.75,
        timeSavedMs: 420,
        oldestLoadedAt: "2026-11-03T10:00:00.040Z",
      },
      byKind: {
        table: {
          entries: 1,
          hits: 3,
          misses: 1,
          expirations: 0,
          refreshes: 1,
          reloadsChanged: 0,
          reloadsUnchanged: 1,
          hitRatio: 0.75,
          timeSavedMs: 120,
          oldestLoadedAt: "2026-11-03T10:00:00.040Z",
        },
        listing: {
          entries: 1,
          hits: 3,
          misses: 1,
          expirations: 0,
          refreshes: 0,
          reloadsChanged: 0,
          reloadsUnchanged: 0,
          hitRatio: 0.75,
          timeSavedMs: 300,
          oldestLoadedAt: "2026-11-03T10:05:00.180Z",
        },
      },
    });
  });
});

test("the cache statistics of an empty cache are zero with no ratio and no date", async () => {
  await withCache(async ({ open }) => {
    const empty = {
      entries: 0,
      hits: 0,
      misses: 0,
      expirations: 0,
      refreshes: 0,
      reloadsChanged: 0,
      reloadsUnchanged: 0,
      hitRatio: null,
      timeSavedMs: 0,
      oldestLoadedAt: null,
    };
    assert.deepEqual((await open()).stats(), { total: empty, byKind: { table: empty, listing: empty } });
  });
});

test("an entry reports its counters, times and last load duration", async () => {
  await withCache(async ({ open, clock }) => {
    const cache = await open({ ttlSeconds: 600 });
    await runKnownSequence(
      createMetadataService(timedClient(clock, { ...listingRoutes(), ...cachedTableRoute() }), noStatements, cache),
      clock,
    );
    assert.deepEqual(cache.entry("table", "MAIN.S.T"), {
      cachedAt: "2026-11-03T10:04:00.080Z",
      expiresAt: "2026-11-03T10:14:00.080Z",
      lastUsedAt: "2026-11-03T10:04:00.080Z",
      lastLoadMs: 40,
      hits: 3,
      misses: 1,
      expirations: 0,
      refreshes: 1,
      reloadsChanged: 0,
      reloadsUnchanged: 1,
    });
    assert.equal(cache.entry("listing", "")?.hits, 3, "the catalogs listing has the empty key");
    assert.equal(cache.entry("table", "main.s.missing"), undefined);
  });
});

test("reading the statistics does not change the counters", async () => {
  await withCache(async ({ open, clock }) => {
    const cache = await open();
    await runKnownSequence(
      createMetadataService(timedClient(clock, { ...listingRoutes(), ...cachedTableRoute() }), noStatements, cache),
      clock,
    );
    const before = { stats: cache.stats(), entry: cache.entry("table", "main.s.t") };
    cache.stats();
    cache.entry("table", "main.s.t");
    assert.deepEqual({ stats: cache.stats(), entry: cache.entry("table", "main.s.t") }, before);
  });
});

test("statistics and entries are limited to the cache identity", async () => {
  await withCache(async ({ open, clock }) => {
    const mine = await open({ identity: "identity-a" });
    const other = await open({ identity: "identity-b" });
    await runKnownSequence(
      createMetadataService(timedClient(clock, { ...listingRoutes(), ...cachedTableRoute() }), noStatements, mine),
      clock,
    );
    assert.equal(other.stats().total.entries, 0);
    assert.equal(other.stats().total.hits, 0);
    assert.equal(other.entry("table", "main.s.t"), undefined);
    assert.equal(mine.stats().total.entries, 2);
  });
});

test("bypassed answers are not counted in the statistics", async () => {
  await withCache(async ({ open, path, clock }) => {
    const cache = await open({ ttlSeconds: 600 });
    const metadata = createMetadataService(fakeClient(cachedTableRoute()).client, noStatements, cache);
    await metadata.describeTable("main.s.t");
    const Database = await loadDatabaseSync();
    const other = new Database(path);
    other.exec("CREATE TRIGGER no_update BEFORE UPDATE ON cache_entries BEGIN SELECT RAISE(ABORT, 'read-only'); END;");
    other.close();
    clock.now += 11 * MINUTE;
    assert.equal((await metadata.describeTable("main.s.t")).cache?.status, "bypassed");
    const { total } = cache.stats();
    assert.deepEqual([total.misses, total.expirations, total.hits, total.refreshes], [1, 0, 0, 0]);
  });
});

const DAY = 86_400_000;

test("the purge deletes entries unused for more than 30 days, of every identity, and keeps the rest", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withCache(async ({ open, clock }) => {
    const { client } = fakeClient({ ...listingRoutes(), ...cachedTableRoute() });
    const mine = await open({ identity: "identity-a", ttlSeconds: 90 * 86_400 });
    const other = await open({ identity: "identity-b", ttlSeconds: 90 * 86_400 });
    await createMetadataService(client, noStatements, mine).describeTable("main.s.t");
    await createMetadataService(client, noStatements, mine).listObjects({});
    await createMetadataService(client, noStatements, other).describeTable("main.s.t");
    clock.now += 20 * DAY;
    assert.equal((await createMetadataService(client, noStatements, mine).listObjects({})).cache?.status, "hit");
    clock.now += 11 * DAY; // table: 31 days unused; catalogs: 11 days since its last use
    const reopened = await open({ identity: "identity-a", ttlSeconds: 90 * 86_400 });
    assert.equal(reopened.entry("table", "main.s.t"), undefined, "unused for 31 days");
    assert.equal(other.entry("table", "main.s.t"), undefined, "the purge is not limited to one identity");
    assert.notEqual(reopened.entry("listing", ""), undefined, "a read renewed its last use");
  });
});

test("an entry unused for exactly 30 days is kept", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withCache(async ({ open, clock }) => {
    const first = await open({ ttlSeconds: 90 * 86_400 });
    await createMetadataService(fakeClient(cachedTableRoute()).client, noStatements, first).describeTable("main.s.t");
    clock.now += 30 * DAY;
    assert.notEqual((await open()).entry("table", "main.s.t"), undefined);
    clock.now += 1;
    assert.equal((await open()).entry("table", "main.s.t"), undefined);
  });
});

test("the purge also runs every 24 hours, and closing the cache stops the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withCache(async ({ open, clock, warnings }) => {
    const cache = await open({ ttlSeconds: 90 * 86_400 });
    await createMetadataService(fakeClient(cachedTableRoute()).client, noStatements, cache).describeTable("main.s.t");
    clock.now += 31 * DAY;
    t.mock.timers.tick(DAY);
    assert.equal(cache.entry("table", "main.s.t"), undefined, "the timer purged it");
    cache.close();
    t.mock.timers.tick(3 * DAY);
    assert.deepEqual(warnings, [], "no purge runs after close");
  });
});

test("a purge that fails is a warning and the timer keeps running", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withCache(async ({ open, path, warnings }) => {
    await open();
    await breakCacheFile(path);
    t.mock.timers.tick(DAY);
    t.mock.timers.tick(DAY);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /purge/i);
  });
});

test("the purge timer does not keep the process alive", () => {
  const script = `
    const { openMetadataCache } = await import(${JSON.stringify(new URL("../src/metadata-cache.ts", import.meta.url).href)});
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    await openMetadataCache({ path: join(mkdtempSync(join(tmpdir(), "dak-unref-")), "cache.db"), identity: "x", ttlSeconds: 60 });
    console.log("opened");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.status, 0, `the process exits by itself: ${child.stderr}`);
  assert.match(child.stdout, /opened/);
});

test("checkMetadataCache reports the schema version of a healthy file and rejects one that is not a database", async () => {
  await withCache(async ({ open, path }) => {
    assert.deepEqual(await checkMetadataCache(path), { schemaVersion: 0 }, "a file that does not exist yet is empty");
    await open();
    assert.deepEqual(await checkMetadataCache(path), { schemaVersion: 1 });
  });
  await withCache(async ({ path }) => {
    await writeFile(path, "this is not a SQLite database".repeat(100));
    await assert.rejects(checkMetadataCache(path), /not a database/);
  });
});
