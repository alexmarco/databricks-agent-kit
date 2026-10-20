import { mkdir, rename, rm } from "node:fs/promises";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { exportPath } from "./paths.ts";
import type { ChunkSink, ManifestColumn, SinkContext } from "./types.ts";

/** Largest DECIMAL precision whose values a double represents exactly. */
const MAX_REAL_DECIMAL_PRECISION = 15;
const INTEGER_TYPES = new Set(["BYTE", "SHORT", "INT", "LONG", "BOOLEAN"]);
const REAL_TYPES = new Set(["FLOAT", "DOUBLE"]);
const SIDECAR_SUFFIXES = ["-wal", "-journal", "-shm"];
/** Default SQLITE_MAX_COLUMN. */
const MAX_COLUMNS = 2000;

type ChunkValue = string | null;

// Identical copy of loadDatabaseSync in src/logging/repository.ts; share it when a third caller appears.
/** Loads node:sqlite without its one-time ExperimentalWarning (stderr noise for MCP clients). */
async function loadDatabaseSync(): Promise<typeof DatabaseSync> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filtered(this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite")) return;
    return (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/**
 * SQLite column affinity for a Databricks column: integers and booleans give `INTEGER`, floating
 * point and `DECIMAL` of up to 15 digits give `REAL`, and everything else (including `DECIMAL`
 * without a precision or beyond 15 digits, which a double cannot hold exactly) gives `TEXT`.
 */
export function sqliteColumnType(column: ManifestColumn): "INTEGER" | "REAL" | "TEXT" {
  if (INTEGER_TYPES.has(column.type_name)) return "INTEGER";
  if (REAL_TYPES.has(column.type_name)) return "REAL";
  if (
    column.type_name === "DECIMAL" &&
    column.type_precision !== undefined &&
    column.type_precision <= MAX_REAL_DECIMAL_PRECISION
  ) {
    return "REAL";
  }
  return "TEXT";
}

function removePartFiles(partPath: string): Promise<unknown> {
  return Promise.all(
    [partPath, ...SIDECAR_SUFFIXES.map((suffix) => `${partPath}${suffix}`)].map((path) => rm(path, { force: true })),
  );
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Column names that are valid and unique in SQLite, which compares them case-insensitively: an empty
 * name becomes `column_<position>` and a repeated name gets the first free `_2`, `_3`, ... suffix.
 */
function uniqueColumnNames(columns: ManifestColumn[]): string[] {
  const used = new Set<string>();
  return columns.map((column) => {
    const base = column.name === "" ? `column_${column.position}` : column.name;
    let candidate = base;
    for (let suffix = 2; used.has(candidate.toLowerCase()); suffix += 1) candidate = `${base}_${suffix}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function parseChunk(index: number, bytes: Uint8Array, columnCount: number): ChunkValue[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`SQLite export: chunk ${index} is not valid JSON (${(error as Error).message})`);
  }
  if (!Array.isArray(parsed)) throw new Error(`SQLite export: chunk ${index} is not a JSON array of rows`);
  parsed.forEach((row: unknown, rowNumber) => {
    if (!Array.isArray(row)) throw new Error(`SQLite export: row ${rowNumber} of chunk ${index} is not an array`);
    if (row.length !== columnCount) {
      throw new Error(
        `SQLite export: row ${rowNumber} of chunk ${index} has ${row.length} values, expected ${columnCount}`,
      );
    }
  });
  return parsed as ChunkValue[][];
}

/**
 * Sink that loads `JSON_ARRAY` chunks into table `result` of `<id>.db.part` and renames it to
 * `<id>.db` on `finish()`, after closing the database so the file is complete. Values are bound as
 * the received text and the column affinity converts them, except `BOOLEAN`, which becomes 1 or 0.
 * Each chunk is inserted in one transaction, so a failing chunk leaves no partial rows.
 */
export async function createSqliteSink(
  context: SinkContext,
  /** Test seam: receives the database right after it is opened. */
  options: { onOpen?: (database: DatabaseSync) => void } = {},
): Promise<ChunkSink> {
  const finalPath = exportPath(context.dir, context.id, "sqlite");
  const partPath = `${finalPath}.part`;
  const Database = await loadDatabaseSync();
  await mkdir(context.dir, { recursive: true });
  // Export ids are deterministic: a retry after a hard kill must not open the leftovers of the previous attempt.
  await removePartFiles(partPath);
  const database = new Database(partPath);
  options.onOpen?.(database);
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    database.close();
  }

  const names = uniqueColumnNames(context.columns);
  const columnDefinitions = context.columns.map(
    (column, position) => `${quoteIdentifier(names[position] ?? "")} ${sqliteColumnType(column)}`,
  );
  const booleanFlags = context.columns.map((column) => column.type_name === "BOOLEAN");
  let insert: StatementSync;
  try {
    database.exec(`CREATE TABLE result (${columnDefinitions.join(", ")})`);
    insert = database.prepare(`INSERT INTO result VALUES (${context.columns.map(() => "?").join(", ")})`);
  } catch (error) {
    close();
    await removePartFiles(partPath);
    if (error instanceof Error && /too many columns/i.test(error.message)) {
      throw new Error(
        `SQLite export: the result has ${context.columns.length} columns and SQLite allows at most ${MAX_COLUMNS} columns`,
        { cause: error },
      );
    }
    throw error;
  }

  function bindableValues(row: ChunkValue[]): (string | number | null)[] {
    return row.map((value, position) => {
      if (booleanFlags[position] && value === "true") return 1;
      if (booleanFlags[position] && value === "false") return 0;
      return value;
    });
  }

  return {
    async write(chunk) {
      const rows = parseChunk(chunk.index, chunk.bytes, context.columns.length);
      database.exec("BEGIN");
      try {
        for (const row of rows) insert.run(...bindableValues(row));
        database.exec("COMMIT");
      } catch (error) {
        // SQLite may already have rolled back (for example when the disk is full); never mask the original error.
        try {
          if (database.isTransaction) database.exec("ROLLBACK");
        } catch {
          // The original error is the useful one.
        }
        throw error;
      }
    },
    async finish() {
      close();
      await rename(partPath, finalPath);
      return { files: [finalPath] };
    },
    async abort() {
      try {
        close();
      } finally {
        await removePartFiles(partPath);
      }
    },
  };
}
