import { mkdir, open, rename, rm } from "node:fs/promises";
import { exportPath } from "./paths.ts";
import type { ChunkSink, SinkContext } from "./types.ts";

const CSV_SPECIAL_CHARACTERS = /[",\r\n]/;

function quoteCsvField(value: string): string {
  return CSV_SPECIAL_CHARACTERS.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Sink that appends the CSV chunks as downloaded to `<id>.csv.part` and renames it to `<id>.csv` on
 * `finish()`. The first chunk already carries the header; with no chunks the header is built from the
 * column names. Chunk bytes are never parsed or modified.
 */
export async function createCsvSink(context: SinkContext): Promise<ChunkSink> {
  const finalPath = exportPath(context.dir, context.id, "csv");
  const partPath = `${finalPath}.part`;
  await mkdir(context.dir, { recursive: true });
  const handle = await open(partPath, "w");
  let chunksWritten = 0;
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await handle.close();
  }

  return {
    async write(chunk) {
      await handle.appendFile(chunk.bytes);
      chunksWritten += 1;
    },
    async finish() {
      if (chunksWritten === 0) {
        await handle.appendFile(`${context.columns.map((column) => quoteCsvField(column.name)).join(",")}\n`);
      }
      await close();
      await rename(partPath, finalPath);
      return { files: [finalPath] };
    },
    async abort() {
      try {
        await close();
      } finally {
        await rm(partPath, { force: true });
      }
    },
  };
}
