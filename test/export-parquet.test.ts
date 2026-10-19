import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMetadata } from "parquet-wasm/node";
import { createParquetSink } from "../src/export/parquet-sink.ts";
import { exportPath } from "../src/export/paths.ts";
import type { SinkContext } from "../src/export/types.ts";

const sampleBytes = await readFile(new URL("./fixtures/sample.arrows", import.meta.url));

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dak-export-parquet-"));
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

function contextFor(dir: string): SinkContext {
  return { id: "sales-0123abcd", dir, columns: [] };
}

function chunk(index: number, bytes: Uint8Array = sampleBytes) {
  return { index, rowCount: 3, bytes };
}

test("parquet sink writes one Parquet file per chunk and renames the directory on finish", async () => {
  await withTempDir(async (dir) => {
    const context = contextFor(dir);
    const finalPath = exportPath(dir, context.id, "parquet");
    const sink = await createParquetSink(context);
    await sink.write(chunk(0));
    await sink.write(chunk(1));
    assert.equal(await exists(finalPath), false);
    assert.deepEqual(await readdir(`${finalPath}.part`), ["part-00000.parquet", "part-00001.parquet"]);

    const result = await sink.finish();

    assert.deepEqual(result.files, [join(finalPath, "part-00000.parquet"), join(finalPath, "part-00001.parquet")]);
    assert.equal(await exists(`${finalPath}.part`), false);
    for (const file of result.files) {
      const bytes = await readFile(file);
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "PAR1");
      assert.equal(new TextDecoder().decode(bytes.subarray(bytes.length - 4)), "PAR1");
      assert.equal(readMetadata(bytes).fileMetadata().numRows(), 3);
    }
  });
});

test("parquet sink names files with the given chunk index and returns them in chunk order", async () => {
  await withTempDir(async (dir) => {
    const context = contextFor(dir);
    const finalPath = exportPath(dir, context.id, "parquet");
    const sink = await createParquetSink(context);
    await sink.write(chunk(0));
    await sink.write(chunk(3));

    const result = await sink.finish();

    assert.deepEqual(result.files, [join(finalPath, "part-00000.parquet"), join(finalPath, "part-00003.parquet")]);
  });
});

test("parquet sink creates the export directory when it does not exist", async () => {
  await withTempDir(async (dir) => {
    const context = contextFor(join(dir, "nested", "exports"));
    const sink = await createParquetSink(context);
    await sink.write(chunk(0));
    const result = await sink.finish();
    assert.equal(await exists(result.files[0] ?? ""), true);
  });
});

test("parquet sink with no chunks creates an empty final directory", async () => {
  await withTempDir(async (dir) => {
    const context = contextFor(dir);
    const finalPath = exportPath(dir, context.id, "parquet");
    const sink = await createParquetSink(context);

    const result = await sink.finish();

    assert.deepEqual(result, { files: [] });
    assert.deepEqual(await readdir(finalPath), []);
    assert.equal(await exists(`${finalPath}.part`), false);
  });
});

test("parquet sink abort leaves no directory and is idempotent, also after finish", async () => {
  await withTempDir(async (dir) => {
    const context = contextFor(dir);
    const finalPath = exportPath(dir, context.id, "parquet");
    const aborted = await createParquetSink(context);
    await aborted.write(chunk(0));
    await aborted.abort();
    await aborted.abort();
    assert.equal(await exists(`${finalPath}.part`), false);
    assert.equal(await exists(finalPath), false);

    const finished = await createParquetSink(context);
    await finished.write(chunk(0));
    const { files } = await finished.finish();
    await finished.abort();
    assert.equal(await exists(files[0] ?? ""), true);
  });
});

test("parquet sink removes the leftovers of a killed earlier attempt", async () => {
  await withTempDir(async (dir) => {
    const context = contextFor(dir);
    const finalPath = exportPath(dir, context.id, "parquet");
    await mkdir(join(`${finalPath}.part`, "nested"), { recursive: true });
    await writeFile(join(`${finalPath}.part`, "part-00007.parquet"), "stale");

    const sink = await createParquetSink(context);
    await sink.write(chunk(0));
    const result = await sink.finish();

    assert.deepEqual(await readdir(finalPath), ["part-00000.parquet"]);
    assert.equal(result.files.length, 1);
  });
});

test("parquet sink reports a chunk that is not an Arrow stream with its index and keeps earlier files", async () => {
  await withTempDir(async (dir) => {
    const context = contextFor(dir);
    const finalPath = exportPath(dir, context.id, "parquet");
    const sink = await createParquetSink(context);
    await sink.write(chunk(0));

    await assert.rejects(
      sink.write(chunk(1, new TextEncoder().encode("not an arrow stream"))),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /chunk 1/);
        assert.ok(error.cause !== undefined);
        return true;
      },
    );
    assert.deepEqual(await readdir(`${finalPath}.part`), ["part-00000.parquet"]);

    await sink.abort();
    assert.equal(await exists(`${finalPath}.part`), false);
  });
});
