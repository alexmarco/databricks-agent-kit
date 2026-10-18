/**
 * Integration tests against a real Databricks workspace.
 * Run with: DAK_IT_PROFILE=<profile> npm run test:integration
 * Optional: DAK_IT_TABLE (default samples.nyctaxi.trips), DATABRICKS_WAREHOUSE_ID.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultAuthDependencies, resolveAuth } from "../../src/auth.ts";
import { createClient } from "../../src/client.ts";
import { UnsupportedError } from "../../src/errors.ts";
import { createMetadataService } from "../../src/metadata.ts";
import { createSqlService } from "../../src/sql.ts";

const profile = process.env.DAK_IT_PROFILE;
if (profile === undefined || profile === "") {
  throw new Error("Set DAK_IT_PROFILE to the Databricks CLI profile used for integration tests.");
}
const table = process.env.DAK_IT_TABLE ?? "samples.nyctaxi.trips";

const auth = await resolveAuth({ profile, explicitProfile: true, env: process.env }, defaultAuthDependencies(process.env));
const client = createClient(auth, { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
const sql = createSqlService(client, { maxRows: 100, allowWrites: false, defaultWarehouseId: process.env.DATABRICKS_WAREHOUSE_ID ?? auth.profileWarehouseId, maxResultBytes: 100_000 });
const metadata = createMetadataService(client, sql);

test("resolves a warehouse and runs SELECT 1", async () => {
  const warehouses = await sql.listWarehouses();
  assert.ok(warehouses.length > 0, "at least one accessible warehouse");
  const result = await sql.executeSql({ statement: "SELECT 1 AS result" });
  if (result.state !== "SUCCEEDED") {
    const final = await sql.getStatement(result.statementId);
    assert.equal(final.state, "SUCCEEDED");
    return;
  }
  assert.deepEqual(result.rows, [["1"]]);
});

test("lists catalogs and describes the sample table", async () => {
  const catalogs = await metadata.listCatalogs();
  assert.ok(catalogs.length > 0);
  const description = await metadata.describeTable(table);
  assert.equal(description.fullName, table);
  assert.ok(description.columns.length > 0);
  const sample = await metadata.sampleTable(table, 3);
  assert.ok((sample.rows ?? []).length <= 3);
});

test("searches metadata through information_schema", async () => {
  const name = table.split(".").at(-1)!;
  const results = await metadata.searchMetadata({ query: name, limit: 10 });
  assert.ok(results.some((entry) => entry.table === name));
});

test("lineage returns data or an explicit unsupported error", async () => {
  try {
    const lineage = await metadata.tableLineage(table);
    assert.equal(lineage.table, table);
  } catch (error) {
    assert.ok(error instanceof UnsupportedError, `unexpected error: ${(error as Error).message}`);
  }
});

test("the read-only guard blocks writes before reaching the workspace", async () => {
  await assert.rejects(sql.executeSql({ statement: `DELETE FROM ${table}` }), /--allow-writes/);
});
