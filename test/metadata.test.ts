import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetadataService } from "../src/metadata.ts";
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
