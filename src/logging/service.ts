import type { LogLevel } from "../config.ts";
import type { ExecutionStatus, ExecutionTransport, LogRepository, QueueEvent } from "./repository.ts";
import { uuidv7 } from "./uuid.ts";

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const SECRET_KEY = /token|secret|password|authorization|api[-_]?key/i;
const DAY_MS = 86_400_000;

export interface LogServiceOptions {
  repository: LogRepository;
  transport: ExecutionTransport;
  level: LogLevel;
  batchSize?: number;
  flushIntervalMs?: number;
  retentionDays?: number;
  purgeIntervalMs?: number;
}

export interface ExecutionTarget {
  toolName?: string;
  promptName?: string;
  resourceUri?: string;
}

type LogMethod = (message: string, metadata?: Record<string, unknown>, error?: unknown) => void;

export interface ExecutionHandle {
  readonly executionId: string;
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  complete(): void;
  fail(error: unknown): void;
  cancel(): void;
}

export interface LogService {
  readonly lifecycle: ExecutionHandle;
  startExecution(target: ExecutionTarget): ExecutionHandle;
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

export function createLogService(options: LogServiceOptions): LogService {
  const { repository, transport } = options;
  const batchSize = options.batchSize ?? 100;
  const flushIntervalMs = options.flushIntervalMs ?? 5_000;
  const retentionMs = (options.retentionDays ?? 90) * DAY_MS;
  const threshold = LEVEL_ORDER[options.level];
  const queue: QueueEvent[] = [];
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

    const error = log("error");
    return {
      executionId,
      trace: log("trace"),
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error,
      fatal: log("fatal"),
      complete: () => finish("completed"),
      fail: (failure) => {
        error(failure instanceof Error ? failure.message : String(failure), undefined, failure);
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
