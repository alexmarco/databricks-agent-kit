import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LogLevel } from "../config.ts";

/** Lifecycle of an execution: `started` until it completes, fails or is cancelled. */
export type ExecutionStatus = "started" | "completed" | "failed" | "cancelled";
/** MCP transport that served the execution. */
export type ExecutionTransport = "stdio" | "http" | "sse";

/** One tool call, resource read or server lifecycle, identified by a UUID v7. */
export interface Execution {
  executionId: string;
  startedAt: number;
  finishedAt?: number;
  transport: ExecutionTransport;
  toolName?: string;
  promptName?: string;
  resourceUri?: string;
  status: ExecutionStatus;
}

/** One log line of an execution; `metadata` is already redacted. */
export interface LogEntry {
  id?: number;
  executionId: string;
  timestamp: number;
  level: LogLevel;
  category?: string;
  source?: string;
  message: string;
  metadata?: Record<string, unknown>;
  stackTrace?: string;
}

/** Write queued by the log service and persisted in batches by {@link LogRepository.writeBatch}. */
export type QueueEvent =
  | { type: "execution-start"; execution: Execution }
  | { type: "execution-end"; executionId: string; finishedAt: number; status: ExecutionStatus }
  | { type: "log"; entry: LogEntry };

/** Filters of the log search; all are optional and combined with AND. */
export interface SearchLogsRequest {
  level?: string | undefined;
  text?: string | undefined;
  executionId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

/** Matching entries, newest first, and how many match in total regardless of the limit. */
export interface SearchLogsResponse {
  results: LogEntry[];
  total: number;
}

/** Execution, error (error and fatal) and warning counts since a point in time. */
export interface LogStats {
  executions: number;
  errors: number;
  warnings: number;
}

/** SQLite settings, tables and indexes, exposed for tests and diagnostics. */
export interface RepositoryInfo {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  tempStore: number;
  busyTimeout: number;
  tables: string[];
  indexes: string[];
}

/** SQLite store of executions and log entries, shared by every `dak` process of the user. */
export interface LogRepository {
  /** Persists the events in one transaction, in order. */
  writeBatch(events: QueueEvent[]): void;
  recentErrors(limit: number): LogEntry[];
  recentExecutions(limit: number): Execution[];
  executionDetail(executionId: string): { execution: Execution; logs: LogEntry[] } | undefined;
  stats(since: number): LogStats;
  searchLogs(request: SearchLogsRequest): SearchLogsResponse;
  /** Deletes executions started and entries logged before `cutoff` (Unix milliseconds). */
  purge(cutoff: number): void;
  inspect(): RepositoryInfo;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    transport TEXT NOT NULL,
    tool_name TEXT,
    prompt_name TEXT,
    resource_uri TEXT,
    status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    level TEXT NOT NULL,
    category TEXT,
    source TEXT,
    message TEXT NOT NULL,
    metadata TEXT,
    stack_trace TEXT,
    FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_logs_execution ON logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
CREATE INDEX IF NOT EXISTS idx_executions_started_at ON executions(started_at);
`;

type Row = Record<string, unknown>;

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

function toExecution(row: Row): Execution {
  return {
    executionId: row.execution_id as string,
    startedAt: Number(row.started_at),
    ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
    transport: row.transport as ExecutionTransport,
    ...(row.tool_name === null ? {} : { toolName: row.tool_name as string }),
    ...(row.prompt_name === null ? {} : { promptName: row.prompt_name as string }),
    ...(row.resource_uri === null ? {} : { resourceUri: row.resource_uri as string }),
    status: row.status as ExecutionStatus,
  };
}

function toLogEntry(row: Row): LogEntry {
  return {
    id: Number(row.id),
    executionId: row.execution_id as string,
    timestamp: Number(row.timestamp),
    level: row.level as LogLevel,
    ...(row.category === null ? {} : { category: row.category as string }),
    ...(row.source === null ? {} : { source: row.source as string }),
    message: row.message as string,
    ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata as string) as Record<string, unknown> }),
    ...(row.stack_trace === null ? {} : { stackTrace: row.stack_trace as string }),
  };
}

function parseTime(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`'${name}' must be an ISO 8601 date-time, got '${value}'.`);
  return parsed;
}

/** Opens (creating it if needed) the log database at `path`, in WAL mode and readable only by its owner outside Windows. */
export async function openLogRepository(path: string): Promise<LogRepository> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const Database = await loadDatabaseSync();
  const db = new Database(path);
  // Owner-only access; SQLite creates the -wal and -shm files with the database file's permissions.
  if (process.platform !== "win32") chmodSync(path, 0o600);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;",
  );
  db.exec(SCHEMA);

  const insertExecution = db.prepare(
    "INSERT OR REPLACE INTO executions (execution_id, started_at, finished_at, transport, tool_name, prompt_name, resource_uri, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const finishExecution = db.prepare("UPDATE executions SET finished_at = ?, status = ? WHERE execution_id = ?");
  const insertLog = db.prepare(
    "INSERT INTO logs (execution_id, timestamp, level, category, source, message, metadata, stack_trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  function writeBatch(events: QueueEvent[]): void {
    db.exec("BEGIN");
    try {
      for (const event of events) {
        if (event.type === "execution-start") {
          const { execution } = event;
          insertExecution.run(
            execution.executionId,
            execution.startedAt,
            execution.finishedAt ?? null,
            execution.transport,
            execution.toolName ?? null,
            execution.promptName ?? null,
            execution.resourceUri ?? null,
            execution.status,
          );
        } else if (event.type === "execution-end") {
          finishExecution.run(event.finishedAt, event.status, event.executionId);
        } else {
          const { entry } = event;
          insertLog.run(
            entry.executionId,
            entry.timestamp,
            entry.level,
            entry.category ?? null,
            entry.source ?? null,
            entry.message,
            entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
            entry.stackTrace ?? null,
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function searchLogs(request: SearchLogsRequest): SearchLogsResponse {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (request.level !== undefined) {
      clauses.push("level = ?");
      params.push(request.level);
    }
    if (request.text !== undefined) {
      clauses.push("(message LIKE ? OR metadata LIKE ? OR stack_trace LIKE ?)");
      const pattern = `%${request.text}%`;
      params.push(pattern, pattern, pattern);
    }
    if (request.executionId !== undefined) {
      clauses.push("execution_id = ?");
      params.push(request.executionId);
    }
    if (request.from !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(parseTime(request.from, "from"));
    }
    if (request.to !== undefined) {
      clauses.push("timestamp <= ?");
      params.push(parseTime(request.to, "to"));
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const limit = Math.max(1, Math.min(Math.trunc(request.limit ?? 100), 1000));
    const total = Number((db.prepare(`SELECT COUNT(*) AS total FROM logs ${where}`).get(...params) as Row).total);
    const rows = db
      .prepare(`SELECT * FROM logs ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`)
      .all(...params, limit) as Row[];
    return { results: rows.map(toLogEntry), total };
  }

  return {
    writeBatch,
    searchLogs,
    recentErrors: (limit) =>
      (
        db
          .prepare("SELECT * FROM logs WHERE level IN ('error', 'fatal') ORDER BY timestamp DESC, id DESC LIMIT ?")
          .all(limit) as Row[]
      ).map(toLogEntry),
    recentExecutions: (limit) =>
      (db.prepare("SELECT * FROM executions ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).map(toExecution),
    executionDetail: (executionId) => {
      const row = db.prepare("SELECT * FROM executions WHERE execution_id = ?").get(executionId) as Row | undefined;
      if (row === undefined) return undefined;
      const logs = db.prepare("SELECT * FROM logs WHERE execution_id = ? ORDER BY id").all(executionId) as Row[];
      return { execution: toExecution(row), logs: logs.map(toLogEntry) };
    },
    stats: (since) => {
      const executions = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM executions WHERE started_at >= ?").get(since) as Row).n,
      );
      const counts = db
        .prepare(
          "SELECT level, COUNT(*) AS n FROM logs WHERE timestamp >= ? AND level IN ('warn', 'error', 'fatal') GROUP BY level",
        )
        .all(since) as Row[];
      const count = (level: string) => Number(counts.find((entry) => entry.level === level)?.n ?? 0);
      return { executions, errors: count("error") + count("fatal"), warnings: count("warn") };
    },
    purge: (cutoff) => {
      db.prepare("DELETE FROM executions WHERE started_at < ?").run(cutoff);
      db.prepare("DELETE FROM logs WHERE timestamp < ?").run(cutoff);
    },
    inspect: () => {
      const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as Row)[0];
      const names = (type: string) =>
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'").all(type) as Row[]
        ).map((entry) => entry.name as string);
      return {
        journalMode: String(pragma("journal_mode")),
        synchronous: Number(pragma("synchronous")),
        foreignKeys: Number(pragma("foreign_keys")),
        tempStore: Number(pragma("temp_store")),
        busyTimeout: Number(pragma("busy_timeout")),
        tables: names("table"),
        indexes: names("index"),
      };
    },
    close: () => db.close(),
  };
}
