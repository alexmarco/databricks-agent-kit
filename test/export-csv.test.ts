import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCsvSink } from "../src/export/csv-sink.ts";
import { exportPath } from "../src/export/paths.ts";
import type { ManifestColumn } from "../src/export/types.ts";

function column(name: string, position: number): ManifestColumn {
  return { name, type_name: "STRING", type_text: "STRING", position };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dak-export-csv-"));
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

test("csv sink concatenates chunks into <id>.csv and renames the .part file on finish", async () => {
  await withTempDir(async (dir) => {
    const sink = await createCsvSink({ id: "sales-abc", dir, columns: [column("id", 0), column("s", 1)] });
    const finalPath = exportPath(dir, "sales-abc", "csv");

    await sink.write({ index: 0, rowCount: 1, bytes: encoder.encode("id,s\n1,a\n") });
    await sink.write({ index: 1, rowCount: 1, bytes: encoder.encode('2,"b,\nc"\n') });

    assert.equal(await exists(finalPath), false);
    assert.equal(await exists(`${finalPath}.part`), true);

    const result = await sink.finish();

    assert.deepEqual(result, { files: [finalPath] });
    assert.equal(await readFile(finalPath, "utf8"), 'id,s\n1,a\n2,"b,\nc"\n');
    assert.equal(await exists(`${finalPath}.part`), false);
  });
});

test("csv sink abort removes the .part file and leaves no .csv, also when called twice", async () => {
  await withTempDir(async (dir) => {
    const sink = await createCsvSink({ id: "x-1", dir, columns: [column("id", 0)] });
    await sink.write({ index: 0, rowCount: 1, bytes: encoder.encode("id\n1\n") });

    await sink.abort();
    await sink.abort();

    assert.deepEqual(await readdir(dir), []);
  });
});

test("csv sink abort after finish keeps the finished file", async () => {
  await withTempDir(async (dir) => {
    const sink = await createCsvSink({ id: "x-2", dir, columns: [column("id", 0)] });
    await sink.write({ index: 0, rowCount: 1, bytes: encoder.encode("id\n1\n") });
    const { files } = await sink.finish();

    await sink.abort();

    assert.equal(await readFile(files[0] as string, "utf8"), "id\n1\n");
  });
});

test("csv sink writes only the header built from the columns when no chunk arrives", async () => {
  await withTempDir(async (dir) => {
    const sink = await createCsvSink({ id: "empty-1", dir, columns: [column("id", 0), column("s", 1)] });

    const { files } = await sink.finish();

    assert.equal(await readFile(files[0] as string, "utf8"), "id,s\n");
  });
});

test("csv sink quotes header names containing a comma, quote, CR or LF", async () => {
  await withTempDir(async (dir) => {
    const columns = [column("a,b", 0), column('say "hi"', 1), column("cr\rx", 2), column("lf\ny", 3), column("plain", 4)];
    const sink = await createCsvSink({ id: "quoted-1", dir, columns });

    const { files } = await sink.finish();

    assert.equal(await readFile(files[0] as string, "utf8"), '"a,b","say ""hi""","cr\rx","lf\ny",plain\n');
  });
});

test("csv sink creates the export directory when it does not exist", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "a", "b");
    const sink = await createCsvSink({ id: "nested-1", dir: nested, columns: [column("id", 0)] });
    await sink.write({ index: 0, rowCount: 1, bytes: encoder.encode("id\n1\n") });

    const { files } = await sink.finish();

    assert.equal(files[0], exportPath(nested, "nested-1", "csv"));
    assert.equal(await readFile(files[0] as string, "utf8"), "id\n1\n");
  });
});

test("csv sink abort before any write removes the .part file", async () => {
  await withTempDir(async (dir) => {
    const sink = await createCsvSink({ id: "early-1", dir, columns: [column("id", 0)] });

    await sink.abort();

    assert.deepEqual(await readdir(dir), []);
  });
});

test("csv sink finish replaces an already existing final file", async () => {
  await withTempDir(async (dir) => {
    const finalPath = exportPath(dir, "replace-1", "csv");
    await writeFile(finalPath, "old\n");
    const sink = await createCsvSink({ id: "replace-1", dir, columns: [column("id", 0)] });
    await sink.write({ index: 0, rowCount: 1, bytes: encoder.encode("id\n1\n") });

    await sink.finish();

    assert.equal(await readFile(finalPath, "utf8"), "id\n1\n");
    assert.deepEqual(await readdir(dir), ["replace-1.csv"]);
  });
});

/** The class of the file handles returned by `fs/promises.open`, so a test can make them misbehave. */
type FileHandlePrototype = Record<string, (this: FileHandle, ...args: never[]) => unknown>;

async function fileHandlePrototype(dir: string): Promise<FileHandlePrototype> {
  const probe = await open(join(dir, "probe"), "w");
  try {
    return Object.getPrototypeOf(probe) as FileHandlePrototype;
  } finally {
    await probe.close();
    await rm(join(dir, "probe"));
  }
}

test("csv sink keeps every byte of a chunk even when single writes are short", async () => {
  await withTempDir(async (dir) => {
    const prototype = await fileHandlePrototype(dir);
    const originalWrite = prototype["write"] as (this: FileHandle, buffer: Uint8Array) => Promise<unknown>;
    // Simulate a short write: only half of the requested bytes reach the file per call.
    const shortWrite = mock.method(prototype, "write", function (this: FileHandle, buffer: Uint8Array) {
      return originalWrite.call(this, buffer.subarray(0, Math.ceil(buffer.length / 2)));
    });
    try {
      const sink = await createCsvSink({ id: "short-1", dir, columns: [column("id", 0)] });
      await sink.write({ index: 0, rowCount: 3, bytes: encoder.encode("id\n1\n2\n3\n") });
      const { files } = await sink.finish();

      assert.equal(await readFile(files[0] as string, "utf8"), "id\n1\n2\n3\n");
    } finally {
      shortWrite.mock.restore();
    }
  });
});

test("csv sink abort after a failed write leaves no .part file", async () => {
  await withTempDir(async (dir) => {
    const prototype = await fileHandlePrototype(dir);
    const failure = mock.method(prototype, "appendFile", async () => {
      throw new Error("disk full");
    });
    const failingWrite = mock.method(prototype, "write", async () => {
      throw new Error("disk full");
    });
    try {
      const sink = await createCsvSink({ id: "fail-1", dir, columns: [column("id", 0)] });
      await assert.rejects(sink.write({ index: 0, rowCount: 1, bytes: encoder.encode("id\n1\n") }), /disk full/);

      await sink.abort();

      assert.deepEqual(await readdir(dir), []);
    } finally {
      failure.mock.restore();
      failingWrite.mock.restore();
    }
  });
});

test("csv sink abort removes the .part file even when closing the handle fails", async () => {
  await withTempDir(async (dir) => {
    const prototype = await fileHandlePrototype(dir);
    const originalAppendFile = prototype["appendFile"] as FileHandle["appendFile"];
    let sinkHandle: FileHandle | undefined;
    // `close` is an own property of each handle, so capture the sink handle through a write and patch it.
    const capture = mock.method(prototype, "appendFile", function (this: FileHandle, data: Uint8Array) {
      sinkHandle = this;
      return originalAppendFile.call(this, data);
    });
    try {
      const sink = await createCsvSink({ id: "close-1", dir, columns: [column("id", 0)] });
      await sink.write({ index: 0, rowCount: 1, bytes: encoder.encode("id\n1\n") });
      const originalClose = (sinkHandle as FileHandle).close.bind(sinkHandle);
      (sinkHandle as FileHandle).close = async () => {
        await originalClose();
        throw new Error("close failed");
      };

      await assert.rejects(sink.abort(), /close failed/);

      assert.deepEqual(await readdir(dir), []);
    } finally {
      capture.mock.restore();
    }
  });
});
