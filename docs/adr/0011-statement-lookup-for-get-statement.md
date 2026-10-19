# ADR 0011: Statement lookup for `get_statement`

- Status: Accepted
- Date: 2026-10-19

## Context

ADR 0009 and ADR 0010 moved plain statements and the statement requests of exports behind the statement lifecycle module. `get_statement` still branched in the tool handler: when the export manager knew the id it used the manager's `wait` and `cancel`, otherwise it used the lifecycle's `get` and `cancel`. The export manager owns the job map (the local state of each export: progress, files, the abort of the download), so the lifecycle cannot tell an export id from a plain one. Issue #6 (spec: issue #3) puts one module behind the question "what is statement X?" and settles how that module learns about running exports.

## Decision

A new module, the **statement lookup** (`src/statement-lookup.ts`, `createStatementLookup({ statements, exports })`), answers questions about any statement id. It is a composition of the two modules that already own the facts; neither of them learns about the other.

| Method                                    | Behaviour                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(statementId, { waitSeconds? })`      | An id of an export gives `{ statementId, export }`, the export state now or, with `waitSeconds` above 0, the state when the export ends or the wait is spent. Any other id gives the `StatementResult` of `statements.get`, with the same wait |
| `cancel(statementId)`                     | An id of a running export stops the export (local job, partial files and its Databricks statement) and gives `{ statementId, cancelled: true }`. A finished export is not cancelled: `{ statementId, cancelled: false, export }`. Any other id is cancelled with `statements.cancel` and gives `{ statementId, cancelled: true }` |

- **The lookup learns about running exports by asking the export manager** (`exports.get(statementId)`), not by being told. The manager already is the registry of its jobs; a second registry in the lifecycle would need a notification protocol on every state change and a construction cycle (the manager depends on the lifecycle). Asking keeps one owner per fact and the dependency graph acyclic: `statement lookup` depends on `statements` and `exports`, `exports` depends on `statements`.
- **An unknown id is a plain statement.** Databricks is the authority on statements this process never saw (for example one submitted before a restart), so the lookup forwards it and Databricks' answer or error reaches the agent unchanged.
- **Cancel semantics are the ones of the tool before this change.** An export cancels its own Databricks statement (the manager does it, so the lookup never calls `statements.cancel` for an export id); a finished export is not reported as cancelled; waiting returns the state at the time limit.
- **Response shapes do not change** (design section 4.1). The handler of `get_statement` has one path: `cancel ? lookup.cancel(id) : lookup.get(id, { waitSeconds })`.
- **The server builds the lookup** from its `statements` and `exports` dependencies, so `ServerDependencies` and the composition in `src/cli.ts` do not change. The workspace session slice may move this construction when it rewrites the composition.

Alternatives considered:

- *Teach the lifecycle about exports* (an export registry inside `src/statements.ts`, or an `exports` option on `createStatementLifecycle`): the lifecycle would depend on the manager and the manager on the lifecycle (a construction cycle that needs late binding), and the lifecycle would have to know export descriptors, which are the manager's. Rejected.
- *Move `get`/`cancel` of plain statements into the export manager*: the manager would speak for statements it does not own, and every consumer of the manager would see a wider interface. Rejected.
- *Leave the branch in the tool handler*: the handler keeps knowing the manager's internals (spec user story 6). Rejected.

## Consequences

- The tool handler holds no export-versus-statement branching. A change to how an id is resolved is made once, in a module that is tested through its interface with fakes of `statements` and `exports` (`test/statement-lookup.test.ts`).
- The server tests keep their behavioural assertions: they build the server from the same fakes, and the lookup is built inside it.
- Behaviour visible to the agent and the operator does not change.
