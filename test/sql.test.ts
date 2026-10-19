import { test } from "node:test";
import assert from "node:assert/strict";
import { createSqlService, isReadCommand, ReadOnlyViolationError, SqlError } from "../src/sql.ts";
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

const options = { maxRows: 1000, allowWrites: true, defaultWarehouseId: "wh-default", maxResultBytes: 100_000 };
const readOnly = { ...options, allowWrites: false };

/** Response of a finished DESCRIBE QUERY check, whose rows hold the columns of the query. */
const described = (...rows: string[]) => ({ statement_id: "ds", status: { state: "SUCCEEDED" }, result: { data_array: rows.map((row) => [row]) } });

const failed = (message: string, sqlState?: string) => ({ statement_id: "ck", status: { state: "FAILED", error: { error_code: "BAD_REQUEST", message, ...(sqlState === undefined ? {} : { sql_state: sqlState }) } } });
const notAQuery = failed("[PARSE_SYNTAX_ERROR] Syntax error at or near 'TABLE'.", "42601");

/** Fake warehouse: answers DESCRIBE QUERY checks with the given response and runs everything else. */
function warehouse(check: unknown) {
  return fakeClient((_method, _path, payload) => {
    const statement = (payload as { statement: string }).statement;
    if (statement.startsWith("DESCRIBE QUERY ")) return check;
    return succeeded([["1", "a"]]);
  });
}
const statements = (calls: Array<{ payload: unknown }>) => calls.map((call) => (call.payload as { statement: string }).statement);

test("isReadCommand accepts only a plain leading SHOW, DESCRIBE, DESC or EXPLAIN", () => {
  for (const statement of ["SHOW TABLES", "  \n\tdesc t", "EXPLAIN SELECT 1", "SHOW TABLES;", "SHOW TABLES ; \n", "SHOW", "show\r\ntables"]) {
    assert.equal(isReadCommand(statement), true, JSON.stringify(statement));
  }
  for (const statement of [
    "-- x\rDROP TABLE t /*\nSHOW */",
    "-- x \\\nSHOW\nDROP TABLE t",
    "SHOW_x: BEGIN DROP TABLE t; END",
    "SHOW1: BEGIN DROP TABLE t; END",
    "SHOW\u00e9: BEGIN DROP TABLE t; END",
    "/* /* */ SHOW */ DROP TABLE t",
    "-- c\nSHOW TABLES",
    "/*+ x */ SHOW TABLES",
    "\uFEFFSHOW TABLES",
    "\u00A0SHOW TABLES",
    "\u200BSHOW TABLES",
    "\vSHOW TABLES",
    "\fSHOW TABLES",
    "SHOW TABLES; DROP TABLE t",
    "SHOW : BEGIN DROP TABLE x; END",
    "SHOW: BEGIN SELECT 1 END",
    "DESC\n:x",
    "EXPLAIN \t:",
    "SHOWDROP",
    "DESCRIBEX t",
    "(SELECT 1)",
    "",
  ]) {
    assert.equal(isReadCommand(statement), false, JSON.stringify(statement));
  }
});

test("SHOW and EXPLAIN run with a single API call", async () => {
  for (const statement of ["SHOW TABLES", "EXPLAIN SELECT 1", "  \n\tdesc t", "SHOW TABLES;"]) {
    const { client, calls } = warehouse(described("id"));
    await createSqlService(client, readOnly).executeSql({ statement });
    assert.deepEqual(statements(calls), [statement], statement);
  }
});

test("queries pass DESCRIBE QUERY in the same context and then run", async () => {
  const { client, calls } = warehouse(described("id", "int"));
  const result = await createSqlService(client, readOnly).executeSql({ statement: "SELECT * FROM t WHERE id = :id", parameters: [{ name: "id", value: 7 }], catalog: "main", schema: "s" });
  assert.deepEqual(result.rows, [["1", "a"]]);
  assert.deepEqual(statements(calls), ["DESCRIBE QUERY SELECT * FROM t WHERE id = :id", "SELECT * FROM t WHERE id = :id"]);
  const check = calls[0]!.payload as Record<string, unknown>;
  assert.deepEqual([check.catalog, check.schema, check.parameters, check.on_wait_timeout], ["main", "s", [{ name: "id", value: "7" }], "CANCEL"]);
});

test("statements that only look like reads are rejected and never submitted", async () => {
  for (const statement of ["-- x\rDROP TABLE t /*\nSHOW */", "-- x \\\nSHOW\nDROP TABLE t", "/* /* */ SHOW */ DROP TABLE t", "SHOW: BEGIN SELECT 1 END"]) {
    const { client, calls } = warehouse(notAQuery);
    await assert.rejects(createSqlService(client, readOnly).executeSql({ statement }), ReadOnlyViolationError, JSON.stringify(statement));
    assert.deepEqual(statements(calls), [`DESCRIBE QUERY ${statement}`], JSON.stringify(statement));
  }
});

test("a ';' before the end is rejected in read-only mode without any API call", async () => {
  for (const statement of [
    "SELECT 1; DROP TABLE t",
    "SELECT 'a;b'",
    "SHOW TABLES; DROP TABLE t",
    "SHOW : BEGIN DROP TABLE x; END",
    "SHOW_x: BEGIN DROP TABLE t; END",
    "SHOW1: BEGIN DROP TABLE t; END",
    "SHOW\u00e9: BEGIN DROP TABLE t; END",
  ]) {
    const { client, calls } = warehouse(described("id"));
    const sql = createSqlService(client, readOnly);
    const expected = (error: unknown) => {
      assert.ok(error instanceof ReadOnlyViolationError);
      assert.match(error.message, /several statements or a ';' inside a literal.*:name parameters.*--allow-writes/);
      return true;
    };
    await assert.rejects(sql.executeSql({ statement }), expected, JSON.stringify(statement));
    await assert.rejects(sql.submitExport({ statement }, "csv"), expected, JSON.stringify(statement));
    assert.equal(calls.length, 0, JSON.stringify(statement));
  }
});

test("a single trailing ';' and a ';' inside a parameter value pass the read-only check", async () => {
  for (const request of [{ statement: "SELECT 1;" }, { statement: "SELECT 1 ; \n" }, { statement: "SELECT :p", parameters: [{ name: "p", value: "a;b" }] }]) {
    const { client, calls } = warehouse(described("id"));
    await createSqlService(client, readOnly).executeSql(request);
    assert.deepEqual(statements(calls), [`DESCRIBE QUERY ${request.statement}`, request.statement]);
  }
});

test("writes mode runs statements with a ';' before the end unchecked", async () => {
  const { client, calls } = fakeClient(() => succeeded([]));
  await createSqlService(client, options).executeSql({ statement: "SELECT 1; DROP TABLE t" });
  assert.deepEqual(statements(calls), ["SELECT 1; DROP TABLE t"]);
});

test("a leading comment is rejected with a hint to remove it", async () => {
  const { client, calls } = warehouse(notAQuery);
  await assert.rejects(createSqlService(client, readOnly).executeSql({ statement: "-- c\nSHOW TABLES" }), (error: unknown) => {
    assert.ok(error instanceof ReadOnlyViolationError);
    assert.match(error.message, /PARSE_SYNTAX_ERROR.*--allow-writes.*If the statement starts with a comment, remove it\./);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("a parse error in the check is a read-only violation that mentions --allow-writes", async () => {
  const { client, calls } = warehouse(notAQuery);
  await assert.rejects(createSqlService(client, readOnly).executeSql({ statement: "DELETE FROM t" }), (error: unknown) => {
    assert.ok(error instanceof ReadOnlyViolationError);
    assert.match(error.message, /PARSE_SYNTAX_ERROR.*Syntax error at or near 'TABLE'.*--allow-writes/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("other check failures are SqlError and an unfinished check asks to retry", async () => {
  const missing = warehouse(failed("[TABLE_OR_VIEW_NOT_FOUND] The table `nope` cannot be found.", "42P01"));
  await assert.rejects(createSqlService(missing.client, readOnly).executeSql({ statement: "SELECT * FROM nope" }), (error: unknown) => {
    assert.ok(error instanceof SqlError);
    assert.match(error.message, /^\[BAD_REQUEST\] \[TABLE_OR_VIEW_NOT_FOUND\].*42P01/);
    return true;
  });
  assert.equal(missing.calls.length, 1);

  const starting = warehouse({ statement_id: "ck", status: { state: "CANCELED" } });
  await assert.rejects(createSqlService(starting.client, readOnly).executeSql({ statement: "SELECT 1" }), /warehouse may still be starting/);
});

test("writes mode and server-written SQL skip the read-only check", async () => {
  const writes = fakeClient(() => succeeded([]));
  await createSqlService(writes.client, options).executeSql({ statement: "DELETE FROM t" });
  assert.deepEqual(statements(writes.calls), ["DELETE FROM t"]);
  const internal = fakeClient(() => succeeded([]));
  await createSqlService(internal.client, readOnly).runStatement({ statement: "SELECT 1 FROM system.information_schema.tables" });
  assert.equal(internal.calls.length, 1);
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
    byte_limit: 100_000,
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
  assert.match(result.message ?? "", /get_statement with cancel: true to stop it/);
  assert.doesNotMatch(result.message ?? "", /cancel_statement/);
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

test("runQuery cancels a statement that is still running and asks to retry", async () => {
  const { client, calls } = fakeClient((method) => (method === "POST" && calls.length === 1 ? { statement_id: "st1", status: { state: "RUNNING" } } : {}));
  await assert.rejects(createSqlService(client, readOnly).runQuery({ statement: "SELECT 1" }), (error: unknown) => {
    assert.ok(error instanceof SqlError);
    assert.match(error.message, /did not finish.*warehouse may be starting/);
    return true;
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["POST /api/2.0/sql/statements", "POST /api/2.0/sql/statements/st1/cancel"]);
});

test("runQuery cancels a PENDING statement and returns finished ones without the read-only check", async () => {
  const pending = fakeClient((_method, path) => (path.endsWith("/cancel") ? {} : { statement_id: "st3", status: { state: "PENDING" } }));
  await assert.rejects(createSqlService(pending.client, options).runQuery({ statement: "SELECT 1" }), /did not finish/);
  assert.equal(pending.calls.at(-1)!.path, "/api/2.0/sql/statements/st3/cancel");

  const done = fakeClient(() => succeeded([["1", "a"]]));
  const result = await createSqlService(done.client, readOnly).runQuery({ statement: "SELECT 1" });
  assert.deepEqual(result.rows, [["1", "a"]]);
  assert.equal(done.calls.length, 1);
});

test("getStatement returns every row up to maxRows by default", async () => {
  const rows = Array.from({ length: 500 }, (_, index) => [String(index), "x"]);
  const { client } = fakeClient(() => succeeded(rows));
  const sql = createSqlService(client, options);
  assert.equal((await sql.getStatement("st1")).rowCount, 500);
  assert.equal((await sql.getStatement("st1", { rowLimit: 10 })).rowCount, 10);
});

/** Service whose clock only moves when the injected sleep is called. */
function pollingService(client: DatabricksClient) {
  const clock = { now: 0 };
  const sleeps: number[] = [];
  const sql = createSqlService(client, {
    ...options,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  return { sql, sleeps, clock };
}

test("getStatement polls with growing waits until the statement is terminal", async () => {
  const states = ["RUNNING", "RUNNING", "SUCCEEDED"];
  const { client, calls } = fakeClient(() => {
    const state = states.shift()!;
    return state === "SUCCEEDED" ? succeeded([["1", "a"]]) : { statement_id: "st1", status: { state } };
  });
  const { sql, sleeps } = pollingService(client);
  const result = await sql.getStatement("st1", { waitSeconds: 5 });
  assert.equal(result.state, "SUCCEEDED");
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(calls.length, 3);
});

test("getStatement stops polling when the wait is spent and clamps it to 30 seconds", async () => {
  const { client } = fakeClient(() => ({ statement_id: "st1", status: { state: "RUNNING" } }));
  const { sql, sleeps, clock } = pollingService(client);
  const short = await sql.getStatement("st1", { waitSeconds: 4 });
  assert.equal(short.state, "RUNNING");
  assert.deepEqual(sleeps, [1000, 2000, 1000]);

  sleeps.length = 0;
  clock.now = 0;
  await sql.getStatement("st1", { waitSeconds: 500 });
  assert.equal(sleeps.reduce((total, ms) => total + ms, 0), 30_000);

  sleeps.length = 0;
  await sql.getStatement("st1", { waitSeconds: 0 });
  assert.deepEqual(sleeps, []);
});

test("submitExport posts an external-links statement without row limit", async () => {
  const { client, calls } = fakeClient(() => ({ statement_id: "ex1", status: { state: "PENDING" } }));
  const sql = createSqlService(client, { ...options, maxExportBytes: 5000 });
  const submitted = await sql.submitExport({ statement: "SELECT * FROM t WHERE id = :id", parameters: [{ name: "id", value: 7, type: "INT" }], catalog: "main", schema: "s", rowLimit: 5 }, "csv");
  assert.deepEqual(submitted, { statementId: "ex1", warehouseId: "wh-default" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, "/api/2.0/sql/statements");
  assert.deepEqual(calls[0]!.payload, {
    statement: "SELECT * FROM t WHERE id = :id",
    warehouse_id: "wh-default",
    catalog: "main",
    schema: "s",
    parameters: [{ name: "id", value: "7", type: "INT" }],
    byte_limit: 5000,
    wait_timeout: "0s",
    on_wait_timeout: "CONTINUE",
    disposition: "EXTERNAL_LINKS",
    format: "CSV",
  });
});

test("submitExport maps the formats and defaults the byte limit to 10 GiB", async () => {
  const { client, calls } = fakeClient(() => ({ statement_id: "ex1", status: { state: "RUNNING" } }));
  const sql = createSqlService(client, options);
  await sql.submitExport({ statement: "SELECT 1" }, "parquet");
  await sql.submitExport({ statement: "SELECT 1" }, "sqlite");
  const bodies = calls.map((call) => call.payload as { format: string; byte_limit: number; row_limit?: number });
  assert.deepEqual(bodies.map((body) => body.format), ["ARROW_STREAM", "JSON_ARRAY"]);
  assert.deepEqual(bodies.map((body) => body.byte_limit), [10 * 1024 ** 3, 10 * 1024 ** 3]);
  assert.ok(bodies.every((body) => !("row_limit" in body)));
});

test("submitExport rejects a failed statement", async () => {
  const { client } = fakeClient(() => failed("[TABLE_OR_VIEW_NOT_FOUND] t", "42P01"));
  await assert.rejects(createSqlService(client, options).submitExport({ statement: "SELECT * FROM t" }, "csv"), SqlError);
});

test("submitExport applies the read-only check before posting", async () => {
  const rejected = warehouse(notAQuery);
  await assert.rejects(createSqlService(rejected.client, readOnly).submitExport({ statement: "DELETE FROM t" }, "csv"), ReadOnlyViolationError);
  assert.deepEqual(statements(rejected.calls), ["DESCRIBE QUERY DELETE FROM t"]);

  const accepted = fakeClient((_method, _path, payload) => {
    const body = payload as { statement: string };
    return body.statement.startsWith("DESCRIBE QUERY ") ? described("id") : { statement_id: "ex2", status: { state: "PENDING" } };
  });
  const submitted = await createSqlService(accepted.client, readOnly).submitExport({ statement: "SELECT 1" }, "csv");
  assert.equal(submitted.statementId, "ex2");
  assert.deepEqual(statements(accepted.calls), ["DESCRIBE QUERY SELECT 1", "SELECT 1"]);
  assert.equal((accepted.calls[0]!.payload as { disposition: string }).disposition, "INLINE");
  assert.equal((accepted.calls[1]!.payload as { disposition: string }).disposition, "EXTERNAL_LINKS");
});

test("onWarehouseChosen reports the automatic choice once", async () => {
  const events: unknown[] = [];
  const { client } = fakeClient((method) =>
    method === "GET"
      ? {
          warehouses: [
            { id: "w1", name: "a", state: "STOPPED", enable_serverless_compute: false },
            { id: "w2", name: "b", state: "STOPPED", enable_serverless_compute: true },
          ],
        }
      : succeeded([]),
  );
  const sql = createSqlService(client, { ...options, defaultWarehouseId: undefined, onWarehouseChosen: (event) => events.push(event) });
  await sql.executeSql({ statement: "SELECT 1" });
  await sql.executeSql({ statement: "SELECT 1" });
  assert.deepEqual(events, [{ warehouseId: "w2", name: "b", reason: "serverless" }]);
});

test("onWarehouseChosen reports the running and first reasons", async () => {
  const reasonFor = async (warehouses: unknown[]) => {
    const reasons: string[] = [];
    const { client } = fakeClient(() => ({ warehouses }));
    await createSqlService(client, { ...options, defaultWarehouseId: undefined, onWarehouseChosen: (event) => reasons.push(event.reason) }).resolveWarehouse();
    return reasons;
  };
  assert.deepEqual(await reasonFor([{ id: "w1", name: "a", state: "STOPPED" }, { id: "w2", name: "b", state: "RUNNING" }]), ["running"]);
  assert.deepEqual(await reasonFor([{ id: "w1", name: "a", state: "STOPPED" }]), ["first"]);
});

test("executeSql fills the diagnostics with the duration of the read-only check", async () => {
  let clock = 1000;
  const { client } = warehouse(described("id"));
  const sql = createSqlService(client, { ...readOnly, now: () => (clock += 7) });
  const diagnostics: { checkMs?: number } = {};
  await sql.executeSql({ statement: "SELECT 1" }, diagnostics);
  assert.equal(diagnostics.checkMs, 7);
});

test("diagnostics stay empty when no check ran", async () => {
  const { client } = warehouse(described("id"));
  const fast: { checkMs?: number } = {};
  await createSqlService(client, readOnly).executeSql({ statement: "SHOW TABLES" }, fast);
  assert.deepEqual(fast, {});
  const writes: { checkMs?: number } = {};
  await createSqlService(client, options).executeSql({ statement: "SELECT 1" }, writes);
  assert.deepEqual(writes, {});
});

test("runQuery still reports the unfinished statement when the cancel call fails", async () => {
  const { client, calls } = fakeClient((_method, path) => {
    if (path.endsWith("/cancel")) throw new Error("cancel failed");
    return { statement_id: "st1", status: { state: "RUNNING" } };
  });
  await assert.rejects(createSqlService(client, options).runQuery({ statement: "SELECT 1" }), (error: unknown) => {
    assert.ok(error instanceof SqlError);
    assert.match(error.message, /did not finish.*warehouse may be starting/);
    return true;
  });
  assert.equal(calls.at(-1)!.path, "/api/2.0/sql/statements/st1/cancel");
});

test("getStatement treats a non-finite wait as no wait", async () => {
  const { client, calls } = fakeClient(() => ({ statement_id: "st1", status: { state: "RUNNING" } }));
  const { sql, sleeps } = pollingService(client);
  for (const waitSeconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = await sql.getStatement("st1", { waitSeconds });
    assert.equal(result.state, "RUNNING");
  }
  assert.deepEqual(sleeps, []);
  assert.equal(calls.length, 3);
});

test("a failing onWarehouseChosen callback does not fail the request and the choice stays cached", async () => {
  let notifications = 0;
  const { client, calls } = fakeClient((method) => (method === "GET" ? { warehouses: [{ id: "w1", name: "a", state: "RUNNING" }] } : succeeded([])));
  const sql = createSqlService(client, {
    ...options,
    defaultWarehouseId: undefined,
    onWarehouseChosen: () => {
      notifications++;
      throw new Error("listener failed");
    },
  });
  assert.equal((await sql.executeSql({ statement: "SELECT 1" })).warehouseId, "w1");
  assert.equal((await sql.executeSql({ statement: "SELECT 1" })).warehouseId, "w1");
  assert.equal(notifications, 1);
  assert.equal(calls.filter((call) => call.method === "GET").length, 1);
});

test("submitExport fills the diagnostics with the check duration and the warehouse", async () => {
  let clock = 1000;
  const checked = fakeClient((_method, _path, payload) =>
    (payload as { statement: string }).statement.startsWith("DESCRIBE QUERY ") ? described("id") : { statement_id: "ex3", status: { state: "PENDING" } },
  );
  const diagnostics: { checkMs?: number; warehouseId?: string } = {};
  await createSqlService(checked.client, { ...readOnly, now: () => (clock += 5) }).submitExport({ statement: "SELECT 1" }, "csv", diagnostics);
  assert.equal(diagnostics.checkMs, 5);
  assert.equal(typeof diagnostics.warehouseId, "string");

  const unchecked: { checkMs?: number; warehouseId?: string } = {};
  const submitted = await createSqlService(checked.client, readOnly).submitExport({ statement: "SHOW TABLES" }, "csv", unchecked);
  assert.deepEqual(unchecked, { warehouseId: submitted.warehouseId });
});
