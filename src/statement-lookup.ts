import type { ExportManager } from "./export/manager.ts";
import type { ExportState } from "./export/types.ts";
import type { StatementLifecycle, StatementResult } from "./statements.ts";

/** Collaborators of the statement lookup: the lifecycle for plain statements and the export manager for exports. */
export interface StatementLookupDependencies {
  statements: Pick<StatementLifecycle, "get" | "cancel">;
  exports: Pick<ExportManager, "get" | "wait" | "cancel">;
}

/** Answer about the id of an export: its state. */
export interface ExportStatus {
  statementId: string;
  export: ExportState;
}

/** Outcome of a cancel: `export` is the state of an export that was already finished and so was not cancelled. */
export interface CancelOutcome {
  statementId: string;
  cancelled: boolean;
  export?: ExportState | undefined;
}

/**
 * Creates the statement lookup (ADR 0011): one place that answers questions about any statement id, so the
 * `get_statement` handler does not tell an export from a plain statement. An id that the export manager knows is an
 * export; any other id, including one this process never saw, is a plain statement that Databricks answers for.
 */
export function createStatementLookup({ statements, exports }: StatementLookupDependencies) {
  /**
   * State of the statement. An export gives its state now or, with `waitSeconds` above 0, when it ends or the wait is
   * spent; a plain statement gives its shaped result, polled for `waitSeconds` (see `StatementLifecycle.get`).
   */
  async function get(
    statementId: string,
    { waitSeconds }: { waitSeconds?: number | undefined },
  ): Promise<ExportStatus | StatementResult> {
    const exported = await exports.get(statementId);
    if (exported === undefined) return statements.get(statementId, { waitSeconds });
    const waitMs = (waitSeconds ?? 0) * 1000;
    return { statementId, export: waitMs > 0 ? ((await exports.wait(statementId, waitMs)) ?? exported) : exported };
  }

  /**
   * Cancels the statement. A running export is stopped by the export manager, which also cancels its Databricks
   * statement; a finished export is not reported as cancelled. Any other id is cancelled in Databricks.
   */
  async function cancel(statementId: string): Promise<CancelOutcome> {
    if ((await exports.get(statementId)) === undefined) {
      await statements.cancel(statementId);
    } else if (!(await exports.cancel(statementId))) {
      return { statementId, cancelled: false, export: await exports.get(statementId) };
    }
    return { statementId, cancelled: true };
  }

  return { get, cancel };
}

/** Methods returned by {@link createStatementLookup}. */
export type StatementLookup = ReturnType<typeof createStatementLookup>;
