# ADR 0015: Review fixes for the deepened modules

- Status: Accepted
- Date: 2026-10-19

## Context

A code review of the integration branch `feature/deepen-modules` (spec: issue #3, ADRs 0009 to 0014) found nine points. Seven were fixed; most of the fixes change no interface, but four touch one:

- the read-only policy of the statement lifecycle was chosen by an `origin` argument of the public `submit` (ADR 0009), so any holder of the lifecycle could skip it by passing `"server"`;
- the poll wait of `awaitExport` could not be released when the doctor's 60 s budget aborted it, so a real 10 s timer outlived the report;
- `close()` of the workspace session ignored a build in flight, and the export manager kept accepting exports after `close()`.

This ADR supersedes the parts of ADR 0009 that describe `origin` and of ADR 0014 that describe `close()`; those ADRs are not rewritten.

## Decision

- **The read-only policy is chosen by the entry point, not by an argument.** `submit(request)` runs a statement of the agent and always applies the policy of ADR 0008 unless writes are allowed. `submitServerSql(request)` runs SQL that the server wrote itself (the doctor's probes) without the check and returns a statement that is still running, as `submit` does. `query(request)` is unchanged: server-written SQL that must finish. `submitExport` stays an agent statement under the policy. `StatementOrigin` is gone. The interface has eight methods (one more than ADR 0009) and one parameter less.
- **The tool handlers cannot reach server-written SQL by type.** `createMcpServer` receives `statements` as `AgentStatements = Pick<StatementLifecycle, "submit" | "get" | "cancel">`. The doctor takes `submitServerSql`, `submitExport`, `awaitExport`, `exportChunkLink` and `cancel`, and no `submit`. The metadata service still takes the whole lifecycle but only calls `query`. This is a compile-time separation: the runtime object is one.
- **Waits can be released.** `sleep(ms, signal?)` (`src/abort.ts`) rejects with the signal's reason as soon as the signal aborts and clears its timer. The `sleep` of `StatementLifecycleOptions` and of `WorkspaceAdapters` takes the optional signal, and `awaitExport` passes its own, so an aborted wait leaves no timer that keeps the process alive. A `sleep` that ignores the signal still works: the wait is also wrapped in `untilAborted`.
- **Closing is final.** `ExportManager.close()` cancels the running exports and from then on `start` rejects with a `DakError` ("The server is shutting down"); a `start` whose statement was submitted before the close cancels that statement and rejects. `WorkspaceSession.close()` awaits a build in flight (a failed build has nothing to close), closes the exports of the workspace it built, and from then on `workspace()` rejects with the same kind of error, so a shutdown during the first credential resolution cancels the exports started right after it.
- **Corrections that change no interface:** the automatic warehouse choice is shared while it is in flight, so simultaneous first calls list the warehouses once and report the choice once, and a failed choice is not kept (ADR 0012 states "once"); the execution scope leaves out a success summary that throws and keeps the work's result (ADR 0013); the server serializes the reply of a tool call or recorded resource read inside the scope, so a result that cannot be serialized fails the execution instead of being logged as a success.

Findings not changed, with the evidence:

- *Export errors lose the error class and SQLSTATE.* `awaitExport` keeps the message of the statement alone (`statement.status.error?.message ?? "Export statement ended in state ..."`). That is the message the export manager had before the refactor (`src/export/manager.ts` at `20f2d58`, same expression) and ADR 0010 documents it, so export states stay as they were.
- *The export starts the statement before the duplicate-path check.* The export id and its path contain the statement id, which Databricks assigns on submit, so the path cannot be known before submitting. The order is the one before the refactor (`start` at `20f2d58`) and the rejection already cancels the statement. A duplicate needs Databricks to hand out a statement id that a local export already uses, so the case is a safeguard.
- *The doctor's `SELECT 1` export goes through `DESCRIBE QUERY` first.* Exports were always checked when writes are off (`submitExport` at `20f2d58` called `assertReadOnly`). With this ADR `submit` and `submitExport` are consistent (both agent statements), so the extra call is the cost of exercising the same path as real exports.

## Consequences

- A new entry point cannot skip the policy by passing a value; skipping it needs a method whose name says so, which the tool handlers do not receive.
- Exports started during a shutdown are refused or cancelled; the tool call that races with the shutdown gets an actionable error instead of a statement that keeps running.
- The retry waits of chunk downloads in the export manager still use `untilAborted(deps.sleep(ms), signal)`; they last at most 2 s and the process exits after the shutdown, so they are left as they are.
- Behaviour visible to the agent and the operator does not change, except the error returned for an export or credential request made while the server is shutting down.
