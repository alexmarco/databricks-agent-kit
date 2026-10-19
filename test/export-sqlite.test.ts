import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSink, sqliteColumnType } from "../src/export/sqlite-sink.ts";
import { exportPath } from "../src/export/paths.ts";
import type { ManifestColumn } from "../src/export/types.ts";

const { DatabaseSync } = await import("node:sqlite");

function column(name: string, typeName: string, position: number, typePrecision?: number): ManifestColumn {
  return {
    name,
    type_name: typeName,
    type_text: typeName,
    position,
    ...(typePrecision === undefined ? {} : { type_precision: typePrecision }),
  };
}

function stringColumns(...names: string[]): ManifestColumn[] {
  return names.map((name, position) => column(name, "STRING", position));
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dak-export-sqlite-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const encoder = new TextEncoder();

function chunkBytes(rows: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(rows));
}

function readAll(path: string, sql: string, readBigInts = false): Record<string, unknown>[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(readBigInts);
    return statement.all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

test("sqliteColumnType maps Databricks types to SQLite affinities", () => {
  for (const typeName of ["BYTE", "SHORT", "INT", "LONG", "BOOLEAN"]) {
    assert.equal(sqliteColumnType(column("c", typeName, 0)), "INTEGER", typeName);
  }
  for (const typeName of ["FLOAT", "DOUBLE"]) {
    assert.equal(sqliteColumnType(column("c", typeName, 0)), "REAL", typeName);
  }
  for (const typeName of ["STRING", "DATE", "TIMESTAMP", "BINARY", "ARRAY", "MAP", "STRUCT", "INTERVAL"]) {
    assert.equal(sqliteColumnType(column("c", typeName, 0)), "TEXT", typeName);
  }
});

test("sqliteColumnType maps DECIMAL by precision", () => {
  assert.equal(sqliteColumnType(column("c", "DECIMAL", 0, 15)), "REAL");
  assert.equal(sqliteColumnType(column("c", "DECIMAL", 0, 16)), "TEXT");
  assert.equal(sqliteColumnType(column("c", "DECIMAL", 0, 20)), "TEXT");
  assert.equal(sqliteColumnType(column("c", "DECIMAL", 0)), "TEXT");
});

test("sqlite sink stores typed values in table result and preserves NULLs", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "typed-abc",
      dir,
      columns: [
        column("id", "LONG", 0),
        column("amount", "DECIMAL", 1, 10),
        column("flag", "BOOLEAN", 2),
        column("label", "STRING", 3),
      ],
    });
    await sink.write({
      index: 0,
      rowCount: 2,
      bytes: chunkBytes([
        ["9223372036854775807", "1.50", "true", "x"],
        [null, null, "false", "y"],
      ]),
    });
    const { files } = await sink.finish();
    const finalPath = exportPath(dir, "typed-abc", "sqlite");
    assert.deepEqual(files, [finalPath]);

    const types = readAll(
      finalPath,
      "SELECT typeof(id) AS id, typeof(amount) AS amount, typeof(flag) AS flag, typeof(label) AS label FROM result ORDER BY rowid",
    );
    assert.deepEqual(types, [
      { id: "integer", amount: "real", flag: "integer", label: "text" },
      { id: "null", amount: "null", flag: "integer", label: "text" },
    ]);
    const values = readAll(finalPath, "SELECT id, amount, flag, label FROM result ORDER BY rowid", true);
    assert.deepEqual(values, [
      { id: 9223372036854775807n, amount: 1.5, flag: 1n, label: "x" },
      { id: null, amount: null, flag: 0n, label: "y" },
    ]);
  });
});

test("sqlite sink keeps DECIMAL beyond 15 digits as exact text", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "dec-abc",
      dir,
      columns: [column("big", "DECIMAL", 0, 20)],
    });
    await sink.write({
      index: 0,
      rowCount: 1,
      bytes: chunkBytes([["12345678901234567.89"]]),
    });
    await sink.finish();
    const rows = readAll(exportPath(dir, "dec-abc", "sqlite"), "SELECT big, typeof(big) AS kind FROM result");
    assert.deepEqual(rows, [{ big: "12345678901234567.89", kind: "text" }]);
  });
});

test("sqlite sink quotes hostile column names", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "hostile-abc",
      dir,
      columns: stringColumns('a"b', "with space", "select"),
    });
    await sink.write({
      index: 0,
      rowCount: 1,
      bytes: chunkBytes([["1", "2", "3"]]),
    });
    await sink.finish();
    const rows = readAll(
      exportPath(dir, "hostile-abc", "sqlite"),
      'SELECT "a""b" AS first, "with space" AS second, "select" AS third FROM result',
    );
    assert.deepEqual(rows, [{ first: "1", second: "2", third: "3" }]);
  });
});

test("sqlite sink makes empty and duplicate column names unique", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "dup-abc",
      dir,
      columns: stringColumns("a", "a", "A", "", "a_2", "a"),
    });
    await sink.write({
      index: 0,
      rowCount: 1,
      bytes: chunkBytes([["1", "2", "3", "4", "5", "6"]]),
    });
    await sink.finish();
    const database = new DatabaseSync(exportPath(dir, "dup-abc", "sqlite"), {
      readOnly: true,
    });
    try {
      const names = (
        database.prepare("PRAGMA table_info(result)").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.deepEqual(names, ["a", "a_2", "A_3", "column_3", "a_2_2", "a_4"]);
    } finally {
      database.close();
    }
  });
});

test("sqlite sink inserts chunks in the order written and creates the .db only on finish", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "order-abc",
      dir,
      columns: stringColumns("n"),
    });
    const finalPath = exportPath(dir, "order-abc", "sqlite");
    await sink.write({
      index: 0,
      rowCount: 2,
      bytes: chunkBytes([["1"], ["2"]]),
    });
    await sink.write({ index: 1, rowCount: 1, bytes: chunkBytes([["3"]]) });
    assert.equal(await exists(finalPath), false);
    assert.equal(await exists(`${finalPath}.part`), true);

    await sink.finish();
    assert.equal(await exists(finalPath), true);
    assert.equal(await exists(`${finalPath}.part`), false);
    assert.deepEqual(
      readAll(finalPath, "SELECT n FROM result ORDER BY rowid").map((row) => row.n),
      ["1", "2", "3"],
    );
  });
});

test("sqlite sink with zero chunks yields an existing empty result table", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "empty-abc",
      dir,
      columns: stringColumns("n"),
    });
    await sink.finish();
    assert.deepEqual(readAll(exportPath(dir, "empty-abc", "sqlite"), "SELECT count(*) AS total FROM result"), [
      { total: 0 },
    ]);
  });
});

test("sqlite sink abort leaves no file, is idempotent and is safe after finish", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "abort-abc",
      dir,
      columns: stringColumns("n"),
    });
    await sink.write({ index: 0, rowCount: 1, bytes: chunkBytes([["1"]]) });
    await sink.abort();
    await sink.abort();
    assert.deepEqual(await readdir(dir), []);

    const finished = await createSqliteSink({
      id: "done-abc",
      dir,
      columns: stringColumns("n"),
    });
    await finished.finish();
    await finished.abort();
    assert.deepEqual(await readdir(dir), ["done-abc.db"]);
  });
});

test("sqlite sink abort removes leftover sidecar files", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "side-abc",
      dir,
      columns: stringColumns("n"),
    });
    const partPath = `${exportPath(dir, "side-abc", "sqlite")}.part`;
    for (const suffix of ["-wal", "-journal", "-shm"]) await writeFile(`${partPath}${suffix}`, "x");
    await sink.abort();
    assert.deepEqual(await readdir(dir), []);
  });
});

test("sqlite sink rolls back a chunk whose row fails and keeps earlier chunks", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "atomic-abc",
      dir,
      columns: stringColumns("n"),
    });
    await sink.write({ index: 0, rowCount: 1, bytes: chunkBytes([["1"]]) });
    // A nested array cannot be bound; the first row of this chunk is valid and must be rolled back.
    await assert.rejects(() =>
      sink.write({
        index: 1,
        rowCount: 2,
        bytes: chunkBytes([["2"], [["x"]]]),
      }),
    );
    await sink.write({ index: 2, rowCount: 1, bytes: chunkBytes([["3"]]) });
    await sink.finish();
    assert.deepEqual(
      readAll(exportPath(dir, "atomic-abc", "sqlite"), "SELECT n FROM result ORDER BY rowid").map((row) => row.n),
      ["1", "3"],
    );
  });
});

test("sqlite sink rejects malformed chunks naming the chunk index", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink({
      id: "bad-abc",
      dir,
      columns: stringColumns("a", "b"),
    });
    await assert.rejects(
      () =>
        sink.write({
          index: 3,
          rowCount: 1,
          bytes: chunkBytes({ not: "an array" }),
        }),
      /chunk 3/,
    );
    await assert.rejects(() => sink.write({ index: 4, rowCount: 1, bytes: chunkBytes(["flat"]) }), /chunk 4/);
    await assert.rejects(
      () =>
        sink.write({
          index: 5,
          rowCount: 1,
          bytes: chunkBytes([["only one"]]),
        }),
      /chunk 5/,
    );
    await assert.rejects(
      () =>
        sink.write({
          index: 6,
          rowCount: 1,
          bytes: encoder.encode("not json"),
        }),
      /chunk 6/,
    );
    await sink.finish();
    assert.deepEqual(readAll(exportPath(dir, "bad-abc", "sqlite"), "SELECT count(*) AS total FROM result"), [
      { total: 0 },
    ]);
  });
});

test("sqlite sink reports the insert error, not a rollback error, when the page limit is exhausted", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink(
      { id: "full-abc", dir, columns: stringColumns("n") },
      { onOpen: (database) => database.exec("PRAGMA max_page_count = 3") },
    );
    const bigRows = Array.from({ length: 200 }, () => ["x".repeat(1000)]);
    await assert.rejects(
      () => sink.write({ index: 0, rowCount: bigRows.length, bytes: chunkBytes(bigRows) }),
      (error: Error) => {
        assert.match(error.message, /full/);
        assert.doesNotMatch(error.message, /cannot rollback/);
        return true;
      },
    );
    await sink.abort();
  });
});

test("sqlite sink clears a stale .part database and journal left by a killed export", async () => {
  await withTempDir(async (dir) => {
    const partPath = `${exportPath(dir, "stale-abc", "sqlite")}.part`;
    const stale = new DatabaseSync(partPath);
    stale.exec("CREATE TABLE result (old TEXT); INSERT INTO result VALUES ('stale')");
    stale.close();
    await writeFile(`${partPath}-journal`, "stale journal");

    const sink = await createSqliteSink({ id: "stale-abc", dir, columns: stringColumns("n") });
    await sink.write({ index: 0, rowCount: 1, bytes: chunkBytes([["fresh"]]) });
    await sink.finish();

    assert.deepEqual(await readdir(dir), ["stale-abc.db"]);
    assert.deepEqual(readAll(exportPath(dir, "stale-abc", "sqlite"), "SELECT n FROM result"), [{ n: "fresh" }]);
  });
});

test("sqlite sink abort still removes the .part and sidecars when closing the database throws", async () => {
  await withTempDir(async (dir) => {
    const sink = await createSqliteSink(
      { id: "closefail-abc", dir, columns: stringColumns("n") },
      {
        onOpen: (database) => {
          const realClose = database.close.bind(database);
          database.close = () => {
            realClose();
            throw new Error("close failed");
          };
        },
      },
    );
    const partPath = `${exportPath(dir, "closefail-abc", "sqlite")}.part`;
    for (const suffix of ["-wal", "-journal", "-shm"]) await writeFile(`${partPath}${suffix}`, "x");
    await assert.rejects(() => sink.abort(), /close failed/);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("sqlite sink explains the column limit when the table cannot be created", async () => {
  await withTempDir(async (dir) => {
    const names = Array.from({ length: 2001 }, (_, position) => `c${position}`);
    await assert.rejects(
      () => createSqliteSink({ id: "wide-abc", dir, columns: stringColumns(...names) }),
      /SQLite export.*2000 columns/,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});
