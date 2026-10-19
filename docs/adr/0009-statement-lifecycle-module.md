# ADR 0009: Statement lifecycle module

- Status: Accepted
- Date: 2026-10-19

## Context

The architecture review of 2026-10-19 (candidate 1) found that what a Databricks statement is lives in several modules: `src/sql.ts` submits, polls, cancels and shapes plain statements and applies the read-only policy (ADR 0008); the export manager builds statement URLs and cancels statements with its own request; `dak doctor` writes the statements path by hand and has its own polling loop. The read-only policy is applied separately by `executeSql` and by `submitExport`, and `runStatement`, `runQuery` and `executeSql` differ only in nuances (policy applied or not, cancel when the wait expires). The caller of each of them has to know which one to pick.

This ADR settles the interface of the first slice: plain (inline) statements and the read-only policy. Exports and `get_statement` for exports are migrated by later slices (spec: issue #3).

## Decision

A new module, the **statement lifecycle** (`src/statements.ts`, `createStatementLifecycle`), owns everything that happens to a statement after a caller has a request for it: building the request body, the read-only policy, submitting, polling, cancelling and shaping a bounded inline result. It is the only module that builds the statements path. Its interface:

| Method                                       | Behaviour                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit(request, origin, diagnostics?)`      | Submits a statement inline and returns the shaped result, or its id and state while it is still running                                                              |
| `query(request)`                             | Runs server-written SQL that must finish: a statement still running after the wait is cancelled (best effort) and reported as an error                              |
| `submitExport(request, format, diagnostics?)` | Submits a statement as `EXTERNAL_LINKS` for the export manager and returns its id and warehouse without waiting                                                    |
| `get(statementId, { rowLimit?, waitSeconds? })` | Fetches a statement; with `waitSeconds` polls until it is no longer `PENDING` or `RUNNING` or the wait is spent                                                    |
| `cancel(statementId)`                        | Cancels a statement                                                                                                                                                 |

- **The origin keeps the read-only policy explicit without near-identical methods.** `origin` is `"agent"` or `"server"`. Statements from the agent (`execute_sql`, and exports, which are always the agent's) go through the policy of ADR 0008 unless writes are allowed; statements the server writes itself (metadata queries, doctor probes) skip it. The policy is implemented once, in the module, so a new entry point cannot forget it. `query` is server-written SQL by definition; it is a method of its own because its contract differs (it never returns an unfinished statement), not because of the policy.
- **The module has one polling schedule per use**, owned by it: `get` waits 1 s, 2 s, 3 s... up to the requested wait (0 to 30 s). The export manager (10 s cap) and the doctor (5 s cap, 60 s budget) keep their own loops until their slices move them here.
- **Dependencies are injected**: the `DatabricksClient`, limits (`maxRows`, `maxResultBytes`, `maxExportBytes`, `allowWrites`), the clock and sleep for tests, and `resolveWarehouse(explicit?)`. Warehouse selection stays in `src/sql.ts`, which now holds only that responsibility, until it becomes a module of its own; the lifecycle module only asks for a warehouse id.
- **Diagnostics stay an optional out-parameter** (`checkMs`, `warehouseId`) of `submit` and `submitExport` for now. The execution scope module (a later slice) removes it.
- **Errors are unchanged.** `SqlError` and `ReadOnlyViolationError` move with the module; failed statements keep the Databricks error class and SQLSTATE.

Alternatives considered:

- *One method per intent* (the previous shape: `executeSql`, `runStatement`, `runQuery`, `submitExport`): four near-identical entry points that each caller had to choose between, with the policy applied by the caller's choice. Rejected.
- *A single `execute(request, { policy, disposition, mustFinish })`*: collapses everything into one method, but the interface becomes a bag of flags whose combinations are mostly invalid (an export that must finish, a server statement with the policy). Rejected: a wide interface is shallow.

## Consequences

- The interface fits in five methods and the read-only policy has one implementation; polling, cancellation and result shaping change in one place (locality), and every consumer gets the same behaviour from it (leverage).
- The seam is the module interface, tested against a fake Databricks client (`test/statements.test.ts`). Tests of the helpers that disappeared from `src/sql.ts` are deleted, not kept.
- `src/sql.ts` is reduced to warehouse selection; its tests keep only that.
- Later slices migrate the export manager (its `submitExport` dependency becomes the lifecycle module and its own statement requests move here), `get_statement` for exports and the doctor's download check. Until then `STATEMENTS_PATH` is still written in the export manager and the doctor.
- Behaviour visible to the agent and the operator does not change.
