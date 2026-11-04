import type { ExportManager } from "./export/manager.ts";
import type { ExportFormat, ExportState } from "./export/types.ts";
import type { ExecuteSqlRequest, StatementLifecycle, StatementResult } from "./statements.ts";

/**
 * Collaborators of the agent statements: the part of the lifecycle that runs the agent's statements, always under the
 * read-only policy (ADR 0015), and the export manager.
 */
export interface AgentStatementsDependencies {
  statements: Pick<StatementLifecycle, "submit" | "get" | "cancel">;
  exports: Pick<ExportManager, "start" | "get" | "wait" | "cancel">;
}

/** A statement of the agent: inline, or with `export` written in full to a file. */
export interface ExecuteRequest extends ExecuteSqlRequest {
  export?: { format: ExportFormat; name?: string | undefined } | undefined;
}

/** Answer to an export that has just been started: it is still `PENDING`; follow it with `get`. */
export interface ExportStarted {
  statementId: string;
  state: "PENDING";
  export: ExportState;
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
export function createAgentStatements({ statements, exports }: AgentStatementsDependencies) {
  /** Runs a statement of the agent: inline unless an export is asked for. */
  async function execute({
    export: exportRequest,
    ...request
  }: ExecuteRequest): Promise<StatementResult | ExportStarted> {
    if (exportRequest === undefined) return statements.submit(request);
    // The row limit does not apply to an export: it writes the full result.
    const { rowLimit: _rowLimit, ...statement } = request;
    const state = await exports.start({ statement, format: exportRequest.format, name: exportRequest.name });
    return { statementId: state.statementId, state: "PENDING", export: state };
  }

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

  return { execute, get, cancel };
}

/** Methods returned by {@link createAgentStatements}. */
export type AgentStatements = ReturnType<typeof createAgentStatements>;
