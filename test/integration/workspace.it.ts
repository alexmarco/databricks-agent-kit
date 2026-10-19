/**
 * Integration tests against a real Databricks workspace.
 * Run with: DAK_IT_PROFILE=<profile> npm run test:integration
 * Optional: DAK_IT_TABLE (default samples.nyctaxi.trips), DATABRICKS_WAREHOUSE_ID.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultAuthDependencies, resolveAuth } from "../../src/auth.ts";
import { createClient, type ClientDependencies } from "../../src/client.ts";
import { createExportManager } from "../../src/export/manager.ts";
import type { ExportFormat, ExportState } from "../../src/export/types.ts";
import { openLogRepository } from "../../src/logging/repository.ts";
import { createLogService } from "../../src/logging/service.ts";
import { createMetadataService } from "../../src/metadata.ts";
import { createSqlService } from "../../src/sql.ts";
import { createStatementLifecycle, ReadOnlyViolationError, type StatementResult } from "../../src/statements.ts";

const profile = process.env.DAK_IT_PROFILE;
if (profile === undefined || profile === "") {
  throw new Error("Set DAK_IT_PROFILE to the Databricks CLI profile used for integration tests.");
}
const table = process.env.DAK_IT_TABLE ?? "samples.nyctaxi.trips";
/** Target of the write attempts below; it never exists, so even an executed DROP ... IF EXISTS changes nothing. */
const NEVER_EXISTS = "main.default.dak_it_never_exists";
const EXPORT_TIMEOUT_MS = 10 * 60_000;
/**
 * Messages showing that Databricks refused several statements in one call while parsing it. Extend the list when a
 * real run shows another wording of the same rejection.
 */
const MULTI_STATEMENT_REJECTIONS = [/PARSE_SYNTAX_ERROR/i, /multiple statements/i, /MULTI_STATEMENT/i, /extra input/i, /mismatched input/i];

const auth = await resolveAuth({ profile, explicitProfile: true, env: process.env }, defaultAuthDependencies(process.env));
const clientDependencies: ClientDependencies = { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const client = createClient(auth, clientDependencies);
const sql = createSqlService(client, { defaultWarehouseId: process.env.DATABRICKS_WAREHOUSE_ID ?? auth.profileWarehouseId });
const statementOptions = { maxRows: 100, maxResultBytes: 100_000, resolveWarehouse: sql.resolveWarehouse };
const statements = createStatementLifecycle(client, { ...statementOptions, allowWrites: false });
const writableStatements = createStatementLifecycle(client, { ...statementOptions, allowWrites: true });
const metadata = createMetadataService(client, statements);

// Exports are built like `dak mcp` builds them (src/cli.ts), writing to a fresh directory.
const workDir = await mkdtemp(join(tmpdir(), "dak-it-"));
const exportDir = join(workDir, "exports");
const logs = createLogService({ repository: await openLogRepository(join(workDir, "logs.db")), transport: "stdio", level: "info" });
const exports = createExportManager({ client, statements, fetch: clientDependencies.fetch, dir: exportDir, logs, sleep: clientDependencies.sleep });

/** Statements started by the export tests; `afterEach` cancels them in Databricks whatever the outcome of the test. */
const startedStatements = new Set<string>();

afterEach(async () => {
  // Best effort: cancelling a finished statement is harmless, and a failed cancel must not hide the test result.
  for (const statementId of startedStatements) await statements.cancel(statementId).catch(() => undefined);
  startedStatements.clear();
});

after(async () => {
  await exports.close();
  logs.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Starts an export and records its statement, so `afterEach` cancels it in Databricks even when the test fails. */
async function startExport(statement: string, format: ExportFormat, name: string): Promise<ExportState> {
  const started = await exports.start({ statement: { statement }, format, name });
  startedStatements.add(started.statementId);
  return started;
}

/** Starts an export and waits until it ends. */
async function runExport(statement: string, format: ExportFormat, name: string): Promise<ExportState> {
  const started = await startExport(statement, format, name);
  const state = await exports.wait(started.statementId, EXPORT_TIMEOUT_MS);
  assert.ok(state !== undefined, `export ${started.statementId} is known`);
  return state;
}

const partFiles = async () => (await readdir(exportDir)).filter((entry) => entry.endsWith(".part"));

test("resolves a warehouse and runs SELECT 1", async () => {
  const warehouses = await sql.listWarehouses();
  assert.ok(warehouses.length > 0, "at least one accessible warehouse");
  const result = await statements.submit({ statement: "SELECT 1 AS result" }, "agent");
  if (result.state !== "SUCCEEDED") {
    const final = await statements.get(result.statementId);
    assert.equal(final.state, "SUCCEEDED");
    return;
  }
  assert.deepEqual(result.rows, [["1"]]);
});

test("lists catalogs and describes the sample table", async () => {
  const catalogs = await metadata.listObjects({});
  assert.equal(catalogs.level, "catalogs");
  assert.ok(catalogs.items.length > 0);
  const description = await metadata.describeTable(table, { sampleRows: 3 });
  assert.equal(description.fullName, table);
  assert.ok(description.columns.length > 0);
  assert.ok((description.sample?.rows ?? []).length <= 3);
});

test("searches metadata through information_schema", async () => {
  const name = table.split(".").at(-1)!;
  const results = await metadata.searchMetadata({ query: name, limit: 10 });
  assert.ok(results.some((entry) => entry.table === name));
});

test("lineage returns data or an explicit note when unavailable", async () => {
  const description = await metadata.describeTable(table, { lineage: true });
  assert.ok(description.lineage !== undefined || (description.notes ?? []).some((note) => /lineage/i.test(note)), "lineage or a note about it");
});

test("the read-only guard blocks writes before reaching the workspace", async () => {
  await assert.rejects(statements.submit({ statement: `DELETE FROM ${table}` }, "agent"), /--allow-writes/);
});

test("queries in every read-only form pass DESCRIBE QUERY and run", async () => {
  const queries = [`TABLE ${table}`, "VALUES (1)", `FROM ${table} SELECT *`, "WITH t AS (SELECT 1) SELECT * FROM t", "(SELECT 1)"];
  for (const statement of queries) {
    try {
      const result = await statements.submit({ statement, rowLimit: 1 }, "agent");
      if (result.state === "PENDING" || result.state === "RUNNING") await statements.cancel(result.statementId);
    } catch (error) {
      if (error instanceof ReadOnlyViolationError) {
        assert.fail(`The read-only check rejected the query \`${statement}\`; report it to the maintainer (do not widen the accepted prefixes without them): ${error.message}`);
      }
      throw error;
    }
  }
});

/** Validator for `assert.rejects` that reports the actual error when it is not an instance of one of `types`. */
function rejectedWith(statement: string, ...types: Array<abstract new (...args: never[]) => Error>) {
  return (error: unknown) => {
    assert.ok(
      types.some((type) => error instanceof type),
      `${JSON.stringify(statement)} must be rejected with ${types.map((type) => type.name).join(" or ")}, got: ${String(error)}`,
    );
    return true;
  };
}

test("read-only bypass attempts are rejected", async () => {
  // isReadCommand (src/statements.ts) fast-paths none of these: they do not start with SHOW, DESCRIBE, DESC or EXPLAIN as a
  // whole word after whitespace, or the word is followed by a ':' (a SQL-scripting label), or they hold a ';' before
  // their end. A ';' before the end is rejected locally without any call; the rest reach DESCRIBE QUERY, where a
  // PARSE_SYNTAX_ERROR becomes a ReadOnlyViolationError and any other failure a SqlError.
  const rejected = [
    // Whether `\r` ends the `--` comment or not, DESCRIBE QUERY sees `DROP ...` or `SHOW */`: neither parses as a query.
    `-- x\rDROP TABLE IF EXISTS ${NEVER_EXISTS} /*\nSHOW */`,
    // With or without nested comments, DESCRIBE QUERY sees `DROP ...` or `SHOW */ DROP ...`: neither parses as a query.
    `/* /* */ SHOW */ DROP TABLE IF EXISTS ${NEVER_EXISTS}`,
    // Labelled compound blocks: `SHOW_x` is not the word SHOW, and `SHOW :` is a label; both hold a ';' before the end.
    `SHOW_x: BEGIN DROP TABLE IF EXISTS ${NEVER_EXISTS}; END`,
    `SHOW : BEGIN DROP TABLE IF EXISTS ${NEVER_EXISTS}; END`,
    // Two statements: rejected locally because of the ';' before the end.
    `SHOW CATALOGS; DROP TABLE IF EXISTS ${NEVER_EXISTS}`,
  ];
  for (const statement of rejected) {
    await assert.rejects(statements.submit({ statement }, "agent"), rejectedWith(statement, ReadOnlyViolationError));
  }
});

test("Databricks rejects several statements in one call even with writes enabled", async () => {
  const statement = `SHOW CATALOGS; DROP TABLE IF EXISTS ${NEVER_EXISTS}`;
  const adr = "ADR 0008 and the read-only design assume the Statement Execution API rejects several statements in one call; stop and report it to the maintainer.";
  let result: StatementResult;
  try {
    result = await writableStatements.submit({ statement }, "agent");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      MULTI_STATEMENT_REJECTIONS.some((pattern) => pattern.test(message)),
      `The multi-statement call failed, but not with a recognised multi-statement rejection: ${message}. Decide whether it is the same rejection worded differently (extend MULTI_STATEMENT_REJECTIONS) or an unrelated failure.`,
    );
    return;
  }
  if (result.state === "PENDING" || result.state === "RUNNING") {
    await writableStatements.cancel(result.statementId).catch(() => undefined);
    assert.fail(`Databricks accepted several statements in one call and was still running them (${result.state}; cancelled now). ${adr}`);
  }
  assert.fail(`Databricks accepted several statements in one call (${JSON.stringify(result)}). ${adr}`);
});

test("a multi-chunk CSV export has one header line and every row", { timeout: EXPORT_TIMEOUT_MS + 60_000 }, async () => {
  const state = await runExport("SELECT id FROM range(600000)", "csv", "it-csv");
  assert.equal(state.status, "SUCCEEDED", `export ended with: ${state.error}`);
  const [file] = state.files ?? [];
  assert.ok(file !== undefined);
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter((line) => line !== "");
  assert.equal(lines.length, 600_001);
  assert.equal(lines[0], "id");
  assert.equal(lines.filter((line) => line === "id").length, 1, "only the first chunk carries the header");
});

test("a Parquet export keeps NULL, DATE, BINARY and MAP columns in valid files", { timeout: EXPORT_TIMEOUT_MS + 60_000 }, async () => {
  const state = await runExport("SELECT CAST(NULL AS STRING) a, DATE'2026-01-01' b, X'CAFE' c, map('k', 1) d", "parquet", "it-parquet");
  assert.equal(state.status, "SUCCEEDED", `export ended with: ${state.error}`);
  assert.ok((state.files ?? []).length > 0);
  for (const file of state.files ?? []) {
    const bytes = await readFile(file);
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "PAR1", `${file} starts with PAR1`);
    assert.equal(bytes.subarray(-4).toString("latin1"), "PAR1", `${file} ends with PAR1`);
  }
});

test("a SQLite export holds every row of the manifest", { timeout: EXPORT_TIMEOUT_MS + 60_000 }, async () => {
  const state = await runExport("SELECT id, CAST(id AS STRING) AS s FROM range(1000)", "sqlite", "it-sqlite");
  assert.equal(state.status, "SUCCEEDED", `export ended with: ${state.error}`);
  const statement = await client.get<{ manifest?: { total_row_count?: number } }>(`/api/2.0/sql/statements/${state.statementId}`);
  const [file] = state.files ?? [];
  assert.ok(file !== undefined);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const { rows } = database.prepare("SELECT count(*) AS rows FROM result").get() as { rows: number };
    assert.equal(rows, statement.manifest?.total_row_count);
  } finally {
    database.close();
  }
});

test("two exports with the same name started back to back get distinct ids", { timeout: EXPORT_TIMEOUT_MS + 60_000 }, async () => {
  const first = await startExport("SELECT 1 AS x", "csv", "it-twice");
  const second = await startExport("SELECT 2 AS x", "csv", "it-twice").catch((error: unknown) => {
    assert.fail(`The second export collided with ${first.id} (the export id must hold the full statement id): ${(error as Error).message}`);
  });
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.path, first.path);
  await exports.wait(first.statementId, EXPORT_TIMEOUT_MS);
  await exports.wait(second.statementId, EXPORT_TIMEOUT_MS);
});

test("cancelling an export right after it starts leaves no partial file", { timeout: 5 * 60_000 }, async () => {
  const started = await startExport("SELECT id FROM range(100000000)", "csv", "it-cancel");
  assert.equal(await exports.cancel(started.statementId), true);
  await statements.cancel(started.statementId);
  // The cancel lands while the job still polls the statement, before the sink creates its `.part` file, so the check
  // below is only a safety net; the slow export of test/e2e.test.ts covers the removal of a real `.part` file.
  assert.equal((await exports.get(started.statementId))?.status, "CANCELED");
  assert.deepEqual(await partFiles(), []);
});
