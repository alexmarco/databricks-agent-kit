import type { ExecutionHandle, ExecutionTarget, LogService } from "./logging/service.ts";

/** Timings and choices that code running inside a scope reports for the final log entry of that scope (ADR 0013). */
export interface ExecutionDiagnostics {
  /** Milliseconds spent in the read-only check; unset when no `DESCRIBE QUERY` call was needed. */
  checkMs?: number;
  /** Warehouse an export was submitted to. */
  warehouseId?: string;
}

/** Thrown by the work of a scope to end its execution as `cancelled` instead of `failed`; the scope rethrows it. */
export class ExecutionCancelled extends Error {
  constructor() {
    super("Execution cancelled");
  }
}

/** The single final entry of a scope: written on success at `info`, and on failure by the error's level (ADR 0007). */
export interface FinalEntry<T> {
  /** Message of the success entry. */
  message: string;
  /** Metadata of both entries, such as the described arguments of a tool call. */
  arguments?: Record<string, unknown>;
  /** Metadata of the success entry taken from the result. */
  summarize?(result: T): Record<string, unknown>;
}

/** Owns opening an execution, running work as its current one, the single final entry and the final status. */
export interface ExecutionScope {
  /**
   * Opens an execution for `target`, runs `work` with it as the current one (also across its awaits) and ends it:
   * `completed` when `work` resolves, `cancelled` when it throws {@link ExecutionCancelled} (no entry), `failed` for any
   * other error. Every outcome other than cancelled writes exactly one entry. With `entry`, a success writes the `info`
   * entry and both outcomes carry `{ ...entry.arguments, durationMs, ...summary, ...diagnostics }` (a failure has no
   * summary; a summary that throws is left out and never turns a success into a failure); without it, a success writes nothing and a failure writes its entry without metadata. The error of
   * `work` is always rethrown, after the execution has ended.
   */
  run<T>(target: ExecutionTarget, work: (execution: ExecutionHandle) => Promise<T>, entry?: FinalEntry<T>): Promise<T>;
  /** Adds diagnostics to the final entry of the current scope; outside any scope it does nothing. */
  annotate(diagnostics: ExecutionDiagnostics): void;
}

/**
 * Writes the success entry. It only observes the work, which already happened: a summary that throws is left out of the
 * entry, and an entry that cannot be written is dropped, so neither turns the work's result into a failure.
 */
function writeSuccessEntry<T>(
  execution: ExecutionHandle,
  entry: FinalEntry<T>,
  result: T,
  metadata: (summary?: Record<string, unknown>) => Record<string, unknown> | undefined,
): void {
  let summary: Record<string, unknown> | undefined;
  try {
    summary = entry.summarize?.(result);
  } catch {
    summary = undefined;
  }
  try {
    execution.info(entry.message, metadata(summary));
  } catch {
    // Nothing is left to record the failure on.
  }
}

/** Creates the execution scope on top of the log service, whose `current()` tells which scope the caller runs in. */
export function createExecutionScope(logs: LogService): ExecutionScope {
  const diagnosticsByExecution = new WeakMap<ExecutionHandle, ExecutionDiagnostics>();

  return {
    async run<T>(
      target: ExecutionTarget,
      work: (execution: ExecutionHandle) => Promise<T>,
      entry?: FinalEntry<T>,
    ): Promise<T> {
      const execution = logs.startExecution(target);
      const diagnostics: ExecutionDiagnostics = {};
      diagnosticsByExecution.set(execution, diagnostics);
      const startedAt = Date.now();
      const entryMetadata = (summary?: Record<string, unknown>) =>
        entry === undefined
          ? undefined
          : { ...entry.arguments, durationMs: Date.now() - startedAt, ...summary, ...diagnostics };
      return logs.run(execution, async () => {
        try {
          const result = await work(execution);
          if (entry !== undefined) writeSuccessEntry(execution, entry, result, entryMetadata);
          execution.complete();
          return result;
        } catch (error) {
          if (error instanceof ExecutionCancelled) execution.cancel();
          else execution.fail(error, entryMetadata());
          throw error;
        }
      });
    },
    annotate(diagnostics) {
      const current = diagnosticsByExecution.get(logs.current());
      if (current !== undefined) Object.assign(current, diagnostics);
    },
  };
}
