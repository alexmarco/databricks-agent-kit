import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SQLITE_MODULE_URL = new URL("../src/sqlite.ts", import.meta.url).href;

// A child process, because node:sqlite emits its ExperimentalWarning once per process and the test runner already loaded it.
const loaderScript = `
  const { loadDatabaseSync } = await import(${JSON.stringify(SQLITE_MODULE_URL)});
  const emitWarningBefore = process.emitWarning;
  const Database = await loadDatabaseSync();
  const database = new Database(":memory:");
  database.exec("CREATE TABLE t (value INTEGER); INSERT INTO t VALUES (42)");
  console.log(JSON.stringify({
    value: database.prepare("SELECT value FROM t").get().value,
    emitWarningRestored: process.emitWarning === emitWarningBefore,
  }));
`;

test("loadDatabaseSync gives a working DatabaseSync without the ExperimentalWarning on stderr", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", loaderScript], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { value: 42, emitWarningRestored: true });
  assert.doesNotMatch(child.stderr, /ExperimentalWarning/);
});
