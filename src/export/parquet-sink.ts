import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Compression, Table, WriterPropertiesBuilder, writeParquet } from "parquet-wasm/node";
import { exportPath } from "./paths.ts";
import type { ChunkSink, SinkContext } from "./types.ts";

const CHUNK_INDEX_DIGITS = 5;

/** Converts one Arrow IPC stream into Parquet bytes; `writeParquet` frees the table and the properties. */
function toParquet(index: number, arrowBytes: Uint8Array): Uint8Array {
  try {
    const properties = new WriterPropertiesBuilder().setCompression(Compression.ZSTD).build();
    return writeParquet(Table.fromIPCStream(arrowBytes), properties);
  } catch (error) {
    // wasm failures may surface as plain strings; keep them as the cause of a real Error.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Parquet export: chunk ${index} could not be converted to Parquet (${detail})`, {
      cause: error,
    });
  }
}

/**
 * Sink that converts each Arrow IPC stream chunk into its own ZSTD-compressed Parquet file
 * `part-<index>.parquet` (index padded to 5 digits) inside `<id>.part/` and renames the directory to
 * `<id>` on `finish()`. With no chunks the final directory is created empty.
 */
export async function createParquetSink(context: SinkContext): Promise<ChunkSink> {
  const finalPath = exportPath(context.dir, context.id, "parquet");
  const partPath = `${finalPath}.part`;
  await mkdir(context.dir, { recursive: true });
  // Export ids are deterministic: a retry after a hard kill must not mix in the files of the previous attempt.
  await rm(partPath, { recursive: true, force: true });
  await mkdir(partPath);
  const fileNames: string[] = [];

  return {
    async write(chunk) {
      const parquetBytes = toParquet(chunk.index, chunk.bytes);
      const fileName = `part-${String(chunk.index).padStart(CHUNK_INDEX_DIGITS, "0")}.parquet`;
      await writeFile(join(partPath, fileName), parquetBytes);
      fileNames.push(fileName);
    },
    async finish() {
      await rename(partPath, finalPath);
      return { files: fileNames.map((fileName) => join(finalPath, fileName)) };
    },
    async abort() {
      await rm(partPath, { recursive: true, force: true });
    },
  };
}
