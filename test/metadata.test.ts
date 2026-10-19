import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetadataService, quoteIdentifier } from "../src/metadata.ts";
import type { DatabricksClient, QueryValue } from "../src/client.ts";
import { InvalidArgumentError } from "../src/errors.ts";
import type { ExecuteSqlRequest, SqlService, StatementResult } from "../src/sql.ts";
import { SqlError } from "../src/sql.ts";

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

/** Only `runQuery` exists: a call to any other SQL method fails the test. */
function fakeSql(respond: (request: ExecuteSqlRequest) => StatementResult | Error) {
  const requests: ExecuteSqlRequest[] = [];
  const sql = {
    runQuery: async (request: ExecuteSqlRequest) => {
      requests.push(request);
      const result = respond(request);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as SqlService;
  return { sql, requests };
}

const rowsResult = (columns: string[], rows: Array<Array<string | null>>): StatementResult => ({
  statementId: "s",
  state: "SUCCEEDED",
  columns: columns.map((name) => ({ name, type: "STRING" })),
  rows,
  rowCount: rows.length,
  truncated: false,
});

const noSql = fakeSql(() => new Error("unexpected SQL")).sql;

test("quoteIdentifier backtick-quotes each part and escapes backticks", () => {
  assert.equal(quoteIdentifier("my-cat.default.t`x"), "`my-cat`.`default`.`t``x`");
  assert.throws(() => quoteIdentifier("a..b"), /Invalid/);
  assert.throws(() => quoteIdentifier("a.b.c.d"), /Invalid/);
});

test("the service exposes only listObjects, describeTable and searchMetadata", () => {
  const metadata = createMetadataService(fakeClient({}).client, noSql);
  assert.deepEqual(Object.keys(metadata).sort(), ["describeTable", "listObjects", "searchMetadata"]);
});

test("listObjects without arguments lists catalogs and follows pagination", async () => {
  const { client, calls } = fakeClient({
    "/api/2.1/unity-catalog/catalogs": [
      { catalogs: [{ name: "main", comment: "Main" }], next_page_token: "p2" },
      { catalogs: [{ name: "samples" }] },
    ],
  });
  const listing = await createMetadataService(client, noSql).listObjects({});
  assert.deepEqual(listing, {
    level: "catalogs",
    items: [{ name: "main", comment: "Main" }, { name: "samples", comment: undefined }],
    truncated: false,
  });
  assert.equal(calls[1]!.query?.page_token, "p2");
});

test("listObjects with a catalog lists schemas", async () => {
  const { client, calls } = fakeClient({ "/api/2.1/unity-catalog/schemas": { schemas: [{ name: "default", comment: "d" }] } });
  const listing = await createMetadataService(client, noSql).listObjects({ catalog: "main" });
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
  const listing = await createMetadataService(client, noSql).listObjects({ catalog: "main", schema: "default", pattern: "ORDER*" });
  assert.equal(listing.level, "tables");
  assert.deepEqual(listing.items.map((item) => item.name), ["orders", "order_items"]);
  assert.deepEqual(listing.items[0], { name: "orders", type: "MANAGED", comment: "Orders" });
  assert.equal(calls[0]!.query?.schema_name, "default");
  assert.equal(calls[0]!.query?.omit_columns, true);
});

test("listObjects cuts at the limit and reports truncation", async () => {
  const { client } = fakeClient(tablesRoute);
  const listing = await createMetadataService(client, noSql).listObjects({ catalog: "main", schema: "default", limit: 2 });
  assert.equal(listing.items.length, 2);
  assert.equal(listing.truncated, true);
});

test("listObjects applies the pattern before the limit", async () => {
  const { client } = fakeClient(tablesRoute);
  const listing = await createMetadataService(client, noSql).listObjects({ catalog: "main", schema: "default", pattern: "order*", limit: 2 });
  assert.deepEqual(listing.items.map((item) => item.name), ["orders", "order_items"]);
  assert.equal(listing.truncated, false);
});

test("listObjects defaults the limit to 100 and caps it at 500", async () => {
  const catalogs = Array.from({ length: 600 }, (_, index) => ({ name: `c${index}` }));
  const { client } = fakeClient({ "/api/2.1/unity-catalog/catalogs": { catalogs } });
  const metadata = createMetadataService(client, noSql);
  const byDefault = await metadata.listObjects({});
  assert.equal(byDefault.items.length, 100);
  assert.equal(byDefault.truncated, true);
  const capped = await metadata.listObjects({ limit: 5000 });
  assert.equal(capped.items.length, 500);
  assert.equal(capped.truncated, true);
});

test("listObjects rejects a schema without a catalog", async () => {
  await assert.rejects(createMetadataService(fakeClient({}).client, noSql).listObjects({ schema: "s" }), InvalidArgumentError);
});

test("describeTable returns columns, constraints, clustering, partitions and tags", async () => {
  const { client, calls } = fakeClient({
    "/api/2.1/unity-catalog/tables/main.sales.orders": {
      full_name: "main.sales.orders",
      table_type: "MANAGED",
      data_source_format: "DELTA",
      comment: "One row per order",
      owner: "data-team",
      columns: [
        { name: "order_id", type_text: "bigint", nullable: false, comment: "PK" },
        { name: "customer_id", type_text: "bigint", nullable: true },
        { name: "order_date", type_text: "date", nullable: true, partition_index: 0 },
      ],
      table_constraints: [
        { primary_key_constraint: { name: "pk", child_columns: ["order_id"] } },
        { foreign_key_constraint: { name: "fk", child_columns: ["customer_id"], parent_table: "main.sales.customers", parent_columns: ["id"] } },
      ],
      properties: { clusteringColumns: '[["customer_id"]]', other: "x" },
    },
  });
  const { sql, requests } = fakeSql(() => rowsResult(["column_name", "tag_name", "tag_value"], [[null, "domain", "sales"], ["customer_id", "pii", "true"]]));
  const table = await createMetadataService(client, sql).describeTable("main.sales.orders");
  assert.equal(calls[0]!.path, "/api/2.1/unity-catalog/tables/main.sales.orders");
  assert.deepEqual(table, {
    fullName: "main.sales.orders",
    type: "MANAGED",
    format: "DELTA",
    comment: "One row per order",
    owner: "data-team",
    columns: [
      { name: "order_id", type: "bigint", nullable: false, comment: "PK" },
      { name: "customer_id", type: "bigint", nullable: true, comment: undefined, tags: { pii: "true" } },
      { name: "order_date", type: "date", nullable: true, comment: undefined },
    ],
    primaryKey: ["order_id"],
    foreignKeys: [{ columns: ["customer_id"], references: "main.sales.customers", referencedColumns: ["id"] }],
    clusteringColumns: ["customer_id"],
    partitionColumns: ["order_date"],
    tags: { domain: "sales" },
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.statement, /information_schema\.table_tags/);
  assert.deepEqual(requests[0]!.parameters?.map((parameter) => parameter.value), ["main", "sales", "orders"]);
});

test("describeTable still answers when tags are unavailable", async () => {
  const { client } = fakeClient({ "/api/2.1/unity-catalog/tables/main.s.t": { full_name: "main.s.t", columns: [] } });
  const { sql } = fakeSql(() => new SqlError("[PERMISSION_DENIED] no access"));
  const table = await createMetadataService(client, sql).describeTable("main.s.t");
  assert.equal(table.fullName, "main.s.t");
  assert.match(table.notes?.[0] ?? "", /Tags unavailable.*PERMISSION_DENIED/);
});

test("describeTable reports a tag read that did not finish instead of an empty tag list", async () => {
  const { client } = fakeClient({ "/api/2.1/unity-catalog/tables/main.s.t": { full_name: "main.s.t", columns: [] } });
  const { sql } = fakeSql(() => new SqlError("Statement did not finish in time (PENDING); the warehouse may be starting, retry in a moment."));
  const table = await createMetadataService(client, sql).describeTable("main.s.t");
  assert.equal(table.tags, undefined);
  assert.match(table.notes?.[0] ?? "", /Tags unavailable.*did not finish/);
});

const tableRoute = { "/api/2.1/unity-catalog/tables/main.s.t": { full_name: "main.s.t", columns: [] } };

function describeSql(request: ExecuteSqlRequest): StatementResult {
  if (request.statement.includes("information_schema")) return rowsResult(["column_name", "tag_name", "tag_value"], []);
  if (request.statement.includes("target_table_full_name = :table")) return rowsResult(["table_name", "last_seen"], [["main.raw.orders", "2026-10-01"]]);
  if (request.statement.includes("source_table_full_name = :table")) return rowsResult(["table_name", "last_seen"], [["main.gold.revenue", "2026-10-02"]]);
  return rowsResult(["a"], [["1"], ["2"]]);
}

test("describeTable adds a quoted, bounded sample and lineage on request", async () => {
  const { sql, requests } = fakeSql(describeSql);
  const table = await createMetadataService(fakeClient(tableRoute).client, sql).describeTable("main.s.t", { sampleRows: 2, lineage: true });
  assert.deepEqual(table.sample?.rows, [["1"], ["2"]]);
  assert.deepEqual(table.lineage, {
    upstream: [{ table: "main.raw.orders", lastSeen: "2026-10-01" }],
    downstream: [{ table: "main.gold.revenue", lastSeen: "2026-10-02" }],
  });
  assert.equal(table.notes, undefined);
  const sample = requests.find((request) => request.statement.startsWith("SELECT *"));
  assert.equal(sample?.statement, "SELECT * FROM `main`.`s`.`t` LIMIT 2");
  assert.equal(sample?.rowLimit, 2);
  assert.ok(requests.some((request) => request.statement.includes("system.access.table_lineage")));
});

test("describeTable caps the sample at 100 rows", async () => {
  const { sql, requests } = fakeSql(describeSql);
  await createMetadataService(fakeClient(tableRoute).client, sql).describeTable("main.s.t", { sampleRows: 5000 });
  assert.equal(requests.find((request) => request.statement.startsWith("SELECT *"))?.statement, "SELECT * FROM `main`.`s`.`t` LIMIT 100");
});

test("describeTable runs no sample or lineage query unless asked", async () => {
  const { sql, requests } = fakeSql(describeSql);
  const table = await createMetadataService(fakeClient(tableRoute).client, sql).describeTable("main.s.t");
  assert.equal(table.sample, undefined);
  assert.equal(table.lineage, undefined);
  assert.equal(requests.length, 1);
});

test("describeTable reports unavailable lineage in notes instead of failing", async () => {
  const { sql } = fakeSql((request) =>
    request.statement.includes("table_lineage") ? new SqlError("[TABLE_OR_VIEW_NOT_FOUND] system.access.table_lineage (SQLSTATE 42P01)") : describeSql(request),
  );
  const table = await createMetadataService(fakeClient(tableRoute).client, sql).describeTable("main.s.t", { lineage: true });
  assert.equal(table.lineage, undefined);
  assert.match(table.notes?.join("\n") ?? "", /Lineage is unavailable.*system tables/s);
});

test("describeTable reports a failing sample in notes instead of failing", async () => {
  const { sql } = fakeSql((request) => (request.statement.startsWith("SELECT *") ? new SqlError("[INSUFFICIENT_PERMISSIONS] no SELECT") : describeSql(request)));
  const table = await createMetadataService(fakeClient(tableRoute).client, sql).describeTable("main.s.t", { sampleRows: 5 });
  assert.equal(table.sample, undefined);
  assert.match(table.notes?.join("\n") ?? "", /Sample unavailable.*INSUFFICIENT_PERMISSIONS/);
});

test("describeTable reports a failed lineage statement in notes and keeps the description", async () => {
  const { sql } = fakeSql((request) => (request.statement.includes("table_lineage") ? new SqlError("Statement did not finish in time (RUNNING)") : describeSql(request)));
  const table = await createMetadataService(fakeClient(tableRoute).client, sql).describeTable("main.s.t", { lineage: true });
  assert.equal(table.fullName, "main.s.t");
  assert.equal(table.lineage, undefined);
  assert.match(table.notes?.join("\n") ?? "", /Lineage unavailable: Statement did not finish in time/);
});

test("describeTable does not hide unexpected lineage failures", async () => {
  const { sql } = fakeSql((request) => (request.statement.includes("table_lineage") ? new TypeError("boom") : describeSql(request)));
  await assert.rejects(createMetadataService(fakeClient(tableRoute).client, sql).describeTable("main.s.t", { lineage: true }), TypeError);
});

test("searchMetadata queries information_schema with a parameterized pattern", async () => {
  const { sql, requests } = fakeSql(() =>
    rowsResult(["kind", "catalog", "schema", "table", "column", "comment"], [["table", "main", "sales", "orders", null, "Orders"], ["column", "main", "sales", "orders", "order_total", null]]),
  );
  const results = await createMetadataService(fakeClient({}).client, sql).searchMetadata({ query: "Order", catalog: "main", limit: 20 });
  assert.deepEqual(results, [
    { kind: "table", catalog: "main", schema: "sales", table: "orders", column: null, comment: "Orders" },
    { kind: "column", catalog: "main", schema: "sales", table: "orders", column: "order_total", comment: null },
  ]);
  const request = requests[0]!;
  assert.match(request.statement, /system\.information_schema\.tables/);
  assert.match(request.statement, /system\.information_schema\.columns/);
  assert.match(request.statement, /LIMIT 20/);
  assert.deepEqual(request.parameters, [{ name: "pattern", value: "%order%" }, { name: "catalog", value: "main" }]);
  assert.equal(request.rowLimit, 20);
});

test("searchMetadata surfaces a statement that did not finish instead of an empty list", async () => {
  const { sql } = fakeSql(() => new SqlError("Statement did not finish in time (RUNNING); the warehouse may be starting, retry in a moment."));
  await assert.rejects(createMetadataService(fakeClient({}).client, sql).searchMetadata({ query: "order" }), /did not finish/);
});
