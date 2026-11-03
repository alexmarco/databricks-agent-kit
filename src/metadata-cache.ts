import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionScope } from "./execution-scope.ts";
import { loadDatabaseSync } from "./sqlite.ts";

/** What a cache entry holds: a table description or the full listing of one level (ADR 0021). */
export type CacheKind = "table" | "listing";
/** How an answer was served: from a fresh entry, loaded because none existed or it expired, or reloaded on request. */
export type CacheStatus = "hit" | "miss" | "expired" | "refreshed";

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
}

/** Persistent cache of Databricks metadata answers (ADR 0021). */
export interface MetadataCache {
  /**
   * Serves the entry of `kind` and `key` (case-insensitive) when it is fresh and `refresh` is not set; otherwise runs
   * `load`, stores its value and serves it. A failed `load` stores nothing and rejects, so an error is never cached and
   * an old value is never served in its place.
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

/** Opens (creating it if needed) the cache database, in WAL mode and readable only by its owner outside Windows. */
export async function openMetadataCache(options: MetadataCacheOptions): Promise<MetadataCache> {
  const { identity } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlSeconds * 1000;
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  const Database = await loadDatabaseSync();
  const db = new Database(options.path);
  // Owner-only access; SQLite creates the -wal and -shm files with the database file's permissions.
  if (process.platform !== "win32") chmodSync(options.path, 0o600);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec(SCHEMA);

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

  const isoTime = (milliseconds: unknown) => new Date(Number(milliseconds)).toISOString();

  return {
    async lookup<T>(
      kind: CacheKind,
      key: string,
      load: () => Promise<T>,
      lookupOptions: { refresh?: boolean | undefined } = {},
    ) {
      const normalizedKey = key.toLowerCase();
      const row = select.get(identity, kind, normalizedKey) as Row | undefined;
      const readAt = now();
      if (row !== undefined && lookupOptions.refresh !== true && readAt < Number(row.loaded_at) + ttlMs) {
        touch.run(readAt, identity, kind, normalizedKey);
        options.scope?.annotate({ cacheStatus: "hit" });
        return {
          value: JSON.parse(row.value as string) as T,
          cache: { status: "hit" as const, cachedAt: isoTime(row.loaded_at) },
        };
      }
      const status: CacheStatus = lookupOptions.refresh === true ? "refreshed" : row === undefined ? "miss" : "expired";
      const value = await load();
      const loadedAt = now();
      const serialized = JSON.stringify(value);
      const changed = row !== undefined && row.value !== serialized;
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
    close: () => db.close(),
  };
}
