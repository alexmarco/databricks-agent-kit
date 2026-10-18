import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetadataService, quoteIdentifier } from "../src/metadata.ts";
import type { DatabricksClient, QueryValue } from "../src/client.ts";
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

function fakeSql(respond: (request: ExecuteSqlRequest) => StatementResult | Error) {
  const requests: ExecuteSqlRequest[] = [];
  const sql = {
    executeSql: async (request: ExecuteSqlRequest) => {
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

test("listCatalogs follows pagination", async () => {
  const { client, calls } = fakeClient({
    "/api/2.1/unity-catalog/catalogs": [
      { catalogs: [{ name: "main", comment: "Main" }], next_page_token: "p2" },
      { catalogs: [{ name: "samples" }] },
    ],
  });
  const catalogs = await createMetadataService(client, noSql).listCatalogs();
  assert.deepEqual(catalogs, [{ name: "main", comment: "Main" }, { name: "samples", comment: undefined }]);
  assert.equal(calls[1]!.query?.page_token, "p2");
});

test("listSchemas and listTables pass parent names and filter by pattern", async () => {
  const { client, calls } = fakeClient({
    "/api/2.1/unity-catalog/schemas": { schemas: [{ name: "default", comment: "d" }] },
    "/api/2.1/unity-catalog/tables": {
      tables: [
        { name: "orders", table_type: "MANAGED", comment: "Orders" },
        { name: "customers", table_type: "VIEW" },
        { name: "order_items", table_type: "EXTERNAL" },
      ],
    },
  });
  const metadata = createMetadataService(client, noSql);
  assert.deepEqual(await metadata.listSchemas("main"), [{ name: "default", comment: "d" }]);
  assert.equal(calls[0]!.query?.catalog_name, "main");
  const tables = await metadata.listTables("main", "default", "ORDER*");
  assert.deepEqual(tables.map((table) => table.name), ["orders", "order_items"]);
  assert.equal(calls[1]!.query?.schema_name, "default");
  assert.equal(calls[1]!.query?.omit_columns, true);
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

test("sampleTable quotes the identifier and bounds the limit", async () => {
  const { sql, requests } = fakeSql(() => rowsResult(["a"], [["1"]]));
  const metadata = createMetadataService(fakeClient({}).client, sql);
  await metadata.sampleTable("my-cat.s.t");
  await metadata.sampleTable("c.s.t", 5000);
  assert.equal(requests[0]!.statement, "SELECT * FROM `my-cat`.`s`.`t` LIMIT 10");
  assert.equal(requests[1]!.statement, "SELECT * FROM `c`.`s`.`t` LIMIT 100");
});

test("tableLineage returns upstream and downstream tables", async () => {
  const { sql, requests } = fakeSql((request) =>
    request.statement.includes("target_table_full_name = :table")
      ? rowsResult(["table_name", "last_seen"], [["main.raw.orders", "2026-10-01"]])
      : rowsResult(["table_name", "last_seen"], [["main.gold.revenue", "2026-10-02"]]),
  );
  const lineage = await createMetadataService(fakeClient({}).client, sql).tableLineage("main.sales.orders");
  assert.deepEqual(lineage, {
    table: "main.sales.orders",
    upstream: [{ table: "main.raw.orders", lastSeen: "2026-10-01" }],
    downstream: [{ table: "main.gold.revenue", lastSeen: "2026-10-02" }],
  });
  assert.match(requests[0]!.statement, /system\.access\.table_lineage/);
});

test("tableLineage reports unsupported workspaces explicitly", async () => {
  const { sql } = fakeSql(() => new SqlError("[TABLE_OR_VIEW_NOT_FOUND] system.access.table_lineage (SQLSTATE 42P01)"));
  await assert.rejects(createMetadataService(fakeClient({}).client, sql).tableLineage("a.b.c", "upstream"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "UNSUPPORTED");
    assert.match((error as Error).message, /system tables/i);
    return true;
  });
});
