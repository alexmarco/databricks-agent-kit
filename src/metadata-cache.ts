import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionScope } from "./execution-scope.ts";
import { loadDatabaseSync } from "./sqlite.ts";

/** What a cache entry holds: a table description or the full listing of one level (ADR 0021). */
export type CacheKind = "table" | "listing";
/**
 * How an answer was served: from a fresh entry, loaded because none existed or it expired, reloaded on request, or
 * loaded with no cache because the cache failed.
 */
export type CacheStatus = "hit" | "miss" | "expired" | "refreshed" | "bypassed";

/** The `cache` field of a cached tool answer; `cachedAt` is the load time in ISO 8601. */
export interface CacheInfo {
  status: CacheStatus;
  cachedAt: string;
}

/** Counters and dates of one entry. */
export interface CacheEntryInfo {
  cachedAt: string;
  hits: number;
  misses: number;
  expirations: number;
  refreshes: number;
  reloadsChanged: number;
  reloadsUnchanged: number;
}

export interface MetadataCacheOptions {
  /** Path of `cache.db`; its directory is created when missing. */
  path: string;
  /** Cache identity of the credentials (`AuthProvider.cacheIdentity`): entries and counters never cross identities. */
  identity: string;
  /** Seconds an entry is fresh, counted from its load time when the entry is read. */
  ttlSeconds: number;
  now?: () => number;
  /** Receives the cache status of each lookup for the final log entry of the current execution (ADR 0013). */
  scope?: Pick<ExecutionScope, "annotate">;
  /** Reports a cache failure; the cache never fails a lookup, it answers from Databricks instead. */
  warn?: (message: string, metadata?: Record<string, unknown>, error?: unknown) => void;
}

/** Persistent cache of Databricks metadata answers (ADR 0021). */
export interface MetadataCache {
  /**
   * Serves the entry of `kind` and `key` (case-insensitive) when it is fresh and `refresh` is not set; otherwise runs
   * `load`, stores its value and serves it. A failed `load` stores nothing and rejects, so an error is never cached and
   * an old value is never served in its place. When the cache itself fails, the value is loaded and served as `bypassed`.
   */
  lookup<T>(
    kind: CacheKind,
    key: string,
    load: () => Promise<T>,
    options?: { refresh?: boolean | undefined },
  ): Promise<{ value: T; cache: CacheInfo }>;
  /** Counters and dates of one entry of this identity, or undefined when it is not cached. */
  entry(kind: CacheKind, key: string): CacheEntryInfo | undefined;
  close(): void;
}

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_entries (
  identity TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  first_loaded_at INTEGER NOT NULL,
  loaded_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  last_load_ms INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  expirations INTEGER NOT NULL DEFAULT 0,
  refreshes INTEGER NOT NULL DEFAULT 0,
  reloads_changed INTEGER NOT NULL DEFAULT 0,
  reloads_unchanged INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (identity, kind, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_cache_entries_last_used_at ON cache_entries(last_used_at);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

type Row = Record<string, unknown>;

const FILE_SUFFIXES = ["", "-wal", "-shm"];

/** Opens the database at `path` with the current schema; throws when the file is not a usable cache of this version. */
async function openDatabase(path: string) {
  const Database = await loadDatabaseSync();
  const db = new Database(path);
  try {
    // Owner-only access; SQLite creates the -wal and -shm files with the database file's permissions.
    if (process.platform !== "win32") chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    const version = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`cache.db has schema version ${version}`);
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Opens (creating it if needed) the cache database, in WAL mode and readable only by its owner outside Windows. A file
 * that cannot be used, such as a corrupt one or one of another schema version, is deleted and created again once; if the
 * cache still cannot be opened, every lookup answers from Databricks as `bypassed`.
 */
export async function openMetadataCache(options: MetadataCacheOptions): Promise<MetadataCache> {
  const { identity } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlSeconds * 1000;
  const warn = options.warn ?? (() => undefined);
  const isoTime = (milliseconds: unknown) => new Date(Number(milliseconds)).toISOString();
  const bypassed = <T>(value: T): { value: T; cache: CacheInfo } => {
    options.scope?.annotate({ cacheStatus: "bypassed" });
    return { value, cache: { status: "bypassed", cachedAt: isoTime(now()) } };
  };

  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  let db: Awaited<ReturnType<typeof openDatabase>>;
  try {
    try {
      db = await openDatabase(options.path);
    } catch {
      for (const suffix of FILE_SUFFIXES) rmSync(options.path + suffix, { force: true });
      db = await openDatabase(options.path);
    }
  } catch (error) {
    warn("Metadata cache cannot be opened; answering from Databricks", { path: options.path }, error);
    return {
      lookup: async (_kind, _key, load) => bypassed(await load()),
      entry: () => undefined,
      close: () => undefined,
    };
  }

  const select = db.prepare("SELECT * FROM cache_entries WHERE identity = ? AND kind = ? AND key = ?");
  const touch = db.prepare(
    "UPDATE cache_entries SET hits = hits + 1, last_used_at = ? WHERE identity = ? AND kind = ? AND key = ?",
  );
  const upsert = db.prepare(
    `INSERT INTO cache_entries (identity, kind, key, value, first_loaded_at, loaded_at, last_used_at, last_load_ms,
       misses, expirations, refreshes, reloads_changed, reloads_unchanged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (identity, kind, key) DO UPDATE SET
       value = excluded.value,
       loaded_at = excluded.loaded_at,
       last_used_at = excluded.last_used_at,
       last_load_ms = excluded.last_load_ms,
       misses = misses + excluded.misses,
       expirations = expirations + excluded.expirations,
       refreshes = refreshes + excluded.refreshes,
       reloads_changed = reloads_changed + excluded.reloads_changed,
       reloads_unchanged = reloads_unchanged + excluded.reloads_unchanged`,
  );

  let closed = false;

  return {
    async lookup<T>(
      kind: CacheKind,
      key: string,
      load: () => Promise<T>,
      lookupOptions: { refresh?: boolean | undefined } = {},
    ) {
      const normalizedKey = key.toLowerCase();
      const readAt = now();
      let row: Row | undefined;
      try {
        row = select.get(identity, kind, normalizedKey) as Row | undefined;
        if (row !== undefined && lookupOptions.refresh !== true && readAt < Number(row.loaded_at) + ttlMs) {
          const value = JSON.parse(row.value as string) as T;
          touch.run(readAt, identity, kind, normalizedKey);
          options.scope?.annotate({ cacheStatus: "hit" });
          return { value, cache: { status: "hit" as const, cachedAt: isoTime(row.loaded_at) } };
        }
      } catch (error) {
        warn("Metadata cache cannot be read; answering from Databricks", undefined, error);
        return bypassed(await load());
      }
      const status: CacheStatus = lookupOptions.refresh === true ? "refreshed" : row === undefined ? "miss" : "expired";
      const value = await load();
      const loadedAt = now();
      const serialized = JSON.stringify(value);
      const changed = row !== undefined && row.value !== serialized;
      try {
        upsert.run(
          identity,
          kind,
          normalizedKey,
          serialized,
          loadedAt,
          loadedAt,
          loadedAt,
          loadedAt - readAt,
          status === "miss" ? 1 : 0,
          status === "expired" ? 1 : 0,
          status === "refreshed" ? 1 : 0,
          changed ? 1 : 0,
          row !== undefined && !changed ? 1 : 0,
        );
      } catch (error) {
        warn("Metadata cache cannot be written; answering from Databricks", undefined, error);
        return bypassed(value);
      }
      options.scope?.annotate({ cacheStatus: status });
      return { value, cache: { status, cachedAt: isoTime(loadedAt) } };
    },
    entry(kind, key) {
      const row = select.get(identity, kind, key.toLowerCase()) as Row | undefined;
      if (row === undefined) return undefined;
      return {
        cachedAt: isoTime(row.loaded_at),
        hits: Number(row.hits),
        misses: Number(row.misses),
        expirations: Number(row.expirations),
        refreshes: Number(row.refreshes),
        reloadsChanged: Number(row.reloads_changed),
        reloadsUnchanged: Number(row.reloads_unchanged),
      };
    },
    close: () => {
      if (!closed) db.close();
      closed = true;
    },
  };
}
