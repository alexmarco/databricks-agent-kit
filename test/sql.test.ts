import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnly, createSqlService, ReadOnlyViolationError, SqlError } from "../src/sql.ts";
import type { DatabricksClient, QueryValue } from "../src/client.ts";

type Handler = (method: "GET" | "POST", path: string, payload: unknown) => unknown;

function fakeClient(handler: Handler) {
  const calls: Array<{ method: string; path: string; payload: unknown }> = [];
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>(path: string, query?: Record<string, QueryValue>) => {
      calls.push({ method: "GET", path, payload: query });
      return handler("GET", path, query) as T;
    },
    post: async <T>(path: string, body?: unknown) => {
      calls.push({ method: "POST", path, payload: body });
      return handler("POST", path, body) as T;
    },
  };
  return { client, calls };
}

const succeeded = (rows: Array<Array<string | null>>, extra: Record<string, unknown> = {}) => ({
  statement_id: "st1",
  status: { state: "SUCCEEDED" },
  manifest: {
    schema: { columns: [{ name: "id", type_text: "INT", position: 0 }, { name: "name", type_text: "STRING", position: 1 }] },
    total_row_count: rows.length,
    truncated: false,
    ...extra,
  },
  result: { data_array: rows, row_count: rows.length },
});

const options = { maxRows: 1000, allowWrites: false, defaultWarehouseId: "wh-default", maxResultBytes: 100_000 };

test("guard accepts read statements", () => {
  for (const sql of [
    "SELECT 1",
    "  select * from t;",
    "-- comment\nWITH a AS (SELECT 1) SELECT * FROM a",
    "/* block */ SHOW TABLES IN main.default",
    "DESCRIBE TABLE main.default.t",
    "desc t",
    "EXPLAIN SELECT 1",
    "VALUES (1), (2)",
    "FROM t |> WHERE x > 1",
    "(SELECT 1)",
    "SELECT 'a;b', \"DROP TABLE x\" FROM t",
    "SELECT `delete` FROM t",
  ]) {
    assert.doesNotThrow(() => assertReadOnly(sql), sql);
  }
});

test("guard rejects writes, multiple statements and DML inside WITH", () => {
  for (const sql of [
    "INSERT INTO t VALUES (1)",
    "drop table t",
    "SELECT 1; DROP TABLE t",
    "WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a",
    "with a as (select 1) merge into t using a on true when matched then delete",
    "",
    "-- only a comment",
  ]) {
    assert.throws(() => assertReadOnly(sql), ReadOnlyViolationError, sql);
  }
});

test("read-only violations explain how to enable writes", () => {
  assert.throws(() => assertReadOnly("UPDATE t SET a = 1"), /--allow-writes/);
});

test("executeSql builds the Statement Execution request", async () => {
  const { client, calls } = fakeClient(() => succeeded([["1", "a"]]));
  const sql = createSqlService(client, options);
  await sql.executeSql({ statement: "SELECT * FROM t WHERE id = :id", parameters: [{ name: "id", value: 7, type: "INT" }], catalog: "main", schema: "default", rowLimit: 10 });
  assert.equal(calls[0]!.path, "/api/2.0/sql/statements");
  assert.deepEqual(calls[0]!.payload, {
    statement: "SELECT * FROM t WHERE id = :id",
    warehouse_id: "wh-default",
    catalog: "main",
    schema: "default",
    parameters: [{ name: "id", value: "7", type: "INT" }],
    row_limit: 10,
    wait_timeout: "30s",
    on_wait_timeout: "CONTINUE",
    disposition: "INLINE",
    format: "JSON_ARRAY",
  });
});

test("executeSql shapes a successful result", async () => {
  const { client } = fakeClient(() => succeeded([["1", "a"], ["2", null]]));
  const result = await createSqlService(client, options).executeSql({ statement: "SELECT 1" });
  assert.deepEqual(result, {
    statementId: "st1",
    state: "SUCCEEDED",
    warehouseId: "wh-default",
    columns: [{ name: "id", type: "INT" }, { name: "name", type: "STRING" }],
    rows: [["1", "a"], ["2", null]],
    rowCount: 2,
    truncated: false,
  });
});

test("row limit defaults to 100 and is capped by maxRows", async () => {
  const { client, calls } = fakeClient(() => succeeded([]));
  const sql = createSqlService(client, { ...options, maxRows: 500 });
  await sql.executeSql({ statement: "SELECT 1" });
  await sql.executeSql({ statement: "SELECT 1", rowLimit: 10_000 });
  assert.equal((calls[0]!.payload as { row_limit: number }).row_limit, 100);
  assert.equal((calls[1]!.payload as { row_limit: number }).row_limit, 500);
});

test("API truncation is reported", async () => {
  const { client } = fakeClient(() => succeeded([["1", "a"]], { truncated: true }));
  const result = await createSqlService(client, options).executeSql({ statement: "SELECT 1" });
  assert.equal(result.truncated, true);
});

test("additional chunks are followed until the row limit", async () => {
  const first = succeeded([["1", "a"]], { total_row_count: 3, total_chunk_count: 3 });
  (first.result as Record<string, unknown>).next_chunk_internal_link = "/api/2.0/sql/statements/st1/result/chunks/1";
  const { client, calls } = fakeClient((method, path) => {
    if (method === "POST") return first;
    if (path.endsWith("/chunks/1")) return { data_array: [["2", "b"]], next_chunk_internal_link: "/api/2.0/sql/statements/st1/result/chunks/2" };
    return { data_array: [["3", "c"]] };
  });
  const result = await createSqlService(client, options).executeSql({ statement: "SELECT 1", rowLimit: 2 });
  assert.deepEqual(result.rows, [["1", "a"], ["2", "b"]]);
  assert.equal(result.truncated, true);
  assert.equal(calls.filter((call) => call.method === "GET").length, 1);
});

test("byte cap trims rows and reports truncation", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => [String(index), "x".repeat(100)]);
  const { client } = fakeClient(() => succeeded(rows));
  const result = await createSqlService(client, { ...options, maxResultBytes: 1000 }).executeSql({ statement: "SELECT 1" });
  assert.ok(result.rows!.length < 50);
  assert.ok(JSON.stringify(result.rows).length <= 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, result.rows!.length);
});

test("running statements return the statement id", async () => {
  const { client } = fakeClient(() => ({ statement_id: "st9", status: { state: "RUNNING" } }));
  const result = await createSqlService(client, options).executeSql({ statement: "SELECT 1" });
  assert.equal(result.statementId, "st9");
  assert.equal(result.state, "RUNNING");
  assert.match(result.message ?? "", /get_statement/);
});

test("failed statements raise SqlError with SQLSTATE", async () => {
  const { client } = fakeClient(() => ({
    statement_id: "st2",
    status: { state: "FAILED", error: { error_code: "BAD_REQUEST", message: "[TABLE_OR_VIEW_NOT_FOUND] t", sql_state: "42P01" } },
  }));
  await assert.rejects(createSqlService(client, options).executeSql({ statement: "SELECT * FROM t" }), (error: unknown) => {
    assert.ok(error instanceof SqlError);
    assert.match(error.message, /TABLE_OR_VIEW_NOT_FOUND.*SQLSTATE 42P01/);
    return true;
  });
});

test("read-only guard runs before any API call; writes pass when allowed", async () => {
  const { client, calls } = fakeClient(() => succeeded([]));
  await assert.rejects(createSqlService(client, options).executeSql({ statement: "DELETE FROM t" }), ReadOnlyViolationError);
  assert.equal(calls.length, 0);
  await createSqlService(client, { ...options, allowWrites: true }).executeSql({ statement: "DELETE FROM t" });
  assert.equal(calls.length, 1);
});

test("getStatement and cancelStatement call the statement endpoints", async () => {
  const { client, calls } = fakeClient((method) => (method === "GET" ? succeeded([["1", "a"]]) : {}));
  const sql = createSqlService(client, options);
  const result = await sql.getStatement("st1");
  assert.equal(result.rowCount, 1);
  await sql.cancelStatement("st1");
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["GET /api/2.0/sql/statements/st1", "POST /api/2.0/sql/statements/st1/cancel"]);
});

test("warehouse is chosen automatically when none is configured", async () => {
  const warehouses = {
    warehouses: [
      { id: "w1", name: "classic", state: "STOPPED", cluster_size: "Small", enable_serverless_compute: false },
      { id: "w2", name: "serverless", state: "STOPPED", cluster_size: "2X-Small", enable_serverless_compute: true },
      { id: "w3", name: "running", state: "RUNNING", cluster_size: "Small", enable_serverless_compute: false },
    ],
  };
  const { client, calls } = fakeClient((method) => (method === "GET" ? warehouses : succeeded([])));
  const sql = createSqlService(client, { ...options, defaultWarehouseId: undefined });
  const listed = await sql.listWarehouses();
  assert.deepEqual(listed.map((w) => [w.id, w.isDefault]), [["w1", false], ["w2", false], ["w3", true]]);
  const result = await sql.executeSql({ statement: "SELECT 1" });
  assert.equal(result.warehouseId, "w3");
  assert.equal((calls.at(-1)!.payload as { warehouse_id: string }).warehouse_id, "w3");
  await sql.executeSql({ statement: "SELECT 1", warehouseId: "explicit" });
  assert.equal((calls.at(-1)!.payload as { warehouse_id: string }).warehouse_id, "explicit");
});

test("serverless is preferred over the first stopped warehouse", async () => {
  const { client } = fakeClient(() => ({
    warehouses: [
      { id: "w1", name: "a", state: "STOPPED", enable_serverless_compute: false },
      { id: "w2", name: "b", state: "STOPPED", enable_serverless_compute: true },
    ],
  }));
  assert.equal(await createSqlService(client, { ...options, defaultWarehouseId: undefined }).resolveWarehouse(), "w2");
});

test("no accessible warehouse is an actionable error", async () => {
  const { client } = fakeClient(() => ({}));
  await assert.rejects(createSqlService(client, { ...options, defaultWarehouseId: undefined }).resolveWarehouse(), /DATABRICKS_WAREHOUSE_ID/);
});
