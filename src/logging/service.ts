import { AsyncLocalStorage } from "node:async_hooks";
import type { LogLevel } from "../config.ts";
import { DakError } from "../errors.ts";
import type { ExecutionStatus, ExecutionTransport, LogRepository, QueueEvent } from "./repository.ts";
import { uuidv7 } from "./uuid.ts";

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const SECRET_KEY = /token|secret|password|authorization|api[-_]?key/i;
const DAY_MS = 86_400_000;

/** Log service settings; the optional ones default to the production values. */
export interface LogServiceOptions {
  repository: LogRepository;
  transport: ExecutionTransport;
  /** Entries below this level are dropped; executions are always recorded. */
  level: LogLevel;
  /** Queued events that trigger an immediate flush (default 100). */
  batchSize?: number;
  /** Maximum time an event waits in the queue (default 5 s). */
  flushIntervalMs?: number;
  /** Age after which executions and entries are purged (default 90 days). */
  retentionDays?: number;
  /** Interval between purges after the one at startup (default 24 h). */
  purgeIntervalMs?: number;
}

/** What an execution is about: a tool, a resource or a prompt; none for the server lifecycle. */
export interface ExecutionTarget {
  toolName?: string;
  promptName?: string;
  resourceUri?: string;
}

type LogMethod = (message: string, metadata?: Record<string, unknown>, error?: unknown) => void;

/**
 * Logger bound to one execution; `complete`, `fail` and `cancel` end it, and only the first call counts. `fail` logs a
 * `DakError` as `warn` without stack trace and any other error as `error` with its stack trace; its `metadata` goes into
 * that single entry.
 */
export interface ExecutionHandle {
  readonly executionId: string;
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  complete(): void;
  fail(error: unknown, metadata?: Record<string, unknown>): void;
  cancel(): void;
}

/** Queued writer of executions and log entries. */
export interface LogService {
  readonly lifecycle: ExecutionHandle;
  startExecution(target: ExecutionTarget): ExecutionHandle;
  /** Execution of the running `run()` scope, or the lifecycle execution outside any. */
  current(): ExecutionHandle;
  /** Runs `work` with `execution` as the current one, also across its awaits. */
  run<T>(execution: ExecutionHandle, work: () => Promise<T>): Promise<T>;
  flush(): void;
  close(): void;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(entry)]));
  }
  return value;
}

/**
 * Starts the log service: purges old data, opens the lifecycle execution and batches every write in memory, so a
 * crash only loses the events still queued. Metadata keys that look like secrets are redacted. Never writes to stdout.
 */
export function createLogService(options: LogServiceOptions): LogService {
  const { repository, transport } = options;
  const batchSize = options.batchSize ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 5_000;
  const retentionMs = (options.retentionDays ?? 90) * DAY_MS;
  const threshold = LEVEL_ORDER[options.level];
  const queue: QueueEvent[] = [];
  const scope = new AsyncLocalStorage<ExecutionHandle>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let immediateFlushPending = false;
  let closed = false;

  function flush(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    try {
      repository.writeBatch(batch);
    } catch (error) {
      process.stderr.write(`dak: failed to persist ${batch.length} log events: ${(error as Error).message}\n`);
    }
  }

  function enqueue(event: QueueEvent): void {
    if (closed) return;
    queue.push(event);
    if (queue.length >= batchSize) {
      if (!immediateFlushPending) {
        immediateFlushPending = true;
        setImmediate(() => {
          immediateFlushPending = false;
          flush();
        });
      }
    } else if (flushTimer === undefined) {
      flushTimer = setTimeout(flush, flushIntervalMs);
      flushTimer.unref();
    }
  }

  function purge(): void {
    try {
      repository.purge(Date.now() - retentionMs);
    } catch (error) {
      process.stderr.write(`dak: log purge failed: ${(error as Error).message}\n`);
    }
  }

  function startExecution(target: ExecutionTarget): ExecutionHandle {
    const startedAt = Date.now();
    const executionId = uuidv7(startedAt);
    const source = target.toolName ?? target.resourceUri ?? target.promptName;
    const category = target.toolName !== undefined ? "tool" : target.resourceUri !== undefined ? "resource" : target.promptName !== undefined ? "prompt" : "server";
    let finished = false;
    enqueue({ type: "execution-start", execution: { executionId, startedAt, transport, ...target, status: "started" } });

    const log =
      (level: LogLevel): LogMethod =>
      (message, metadata, error) => {
        if (LEVEL_ORDER[level] < threshold) return;
        const stackTrace = error instanceof Error ? error.stack : undefined;
        enqueue({
          type: "log",
          entry: {
            executionId,
            timestamp: Date.now(),
            level,
            category,
            ...(source === undefined ? {} : { source }),
            message,
            ...(metadata === undefined ? {} : { metadata: redact(metadata) as Record<string, unknown> }),
            ...(stackTrace === undefined ? {} : { stackTrace }),
          },
        });
      };

    const finish = (status: ExecutionStatus) => {
      if (finished) return;
      finished = true;
      enqueue({ type: "execution-end", executionId, finishedAt: Date.now(), status });
    };

    const warn = log("warn");
    const error = log("error");
    return {
      executionId,
      trace: log("trace"),
      debug: log("debug"),
      info: log("info"),
      warn,
      error,
      fatal: log("fatal"),
      complete: () => finish("completed"),
      fail: (failure, metadata) => {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (failure instanceof DakError) warn(message, metadata);
        else error(message, metadata, failure);
        finish("failed");
      },
      cancel: () => finish("cancelled"),
    };
  }

  purge();
  const purgeTimer = setInterval(purge, options.purgeIntervalMs ?? DAY_MS);
  purgeTimer.unref();
  const lifecycle = startExecution({});
  lifecycle.info("Server started", { transport, pid: process.pid });

  return {
    lifecycle,
    startExecution,
    current: () => scope.getStore() ?? lifecycle,
    run: (execution, work) => scope.run(execution, work),
    flush,
    close: () => {
      if (closed) return;
      lifecycle.info("Server stopped");
      lifecycle.complete();
      clearInterval(purgeTimer);
      flush();
      closed = true;
      repository.close();
    },
  };
}
