# ADR 0023: Agent statements module for `execute_sql` and `get_statement`

- Status: Accepted
- Date: 2026-11-04

## Context

[ADR 0011](0011-statement-lookup-for-get-statement.md) put `get` and `cancel` for any statement id behind one module, so the `get_statement` handler does not tell an export from a plain statement. [ADR 0014](0014-workspace-session-module.md) left that module in the server: it was a pure composition, and "moving it into the session would not remove the server's need for `exports.start`". The server therefore built it again on every `get_statement` call.

The other half of the same question stayed in the server too. The `execute_sql` handler decided between an inline statement and an export, translated the tool arguments into a request, dropped the row limit for exports and built the descriptor of a started export. That decision could only be tested through the MCP server. The codebase design review of 2026-11-04 (issue #88) found the two handlers to be one module split in two.

## Decision

The statement lookup becomes the **agent statements** module (`src/agent-statements.ts`, `createAgentStatements({ statements, exports })`): the single entry point for what an agent does with statements.

| Method                               | Behaviour                                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute({ ...request, export? })`   | Without `export`, `statements.submit(request)`: the inline result, under the read-only policy. With `export: { format, name? }`, `exports.start` without the row limit, answering `{ statementId, state: "PENDING", export }` |
| `get(statementId, { waitSeconds? })` | As in ADR 0011                                                                                                                                                                                                                |
| `cancel(statementId)`                | As in ADR 0011                                                                                                                                                                                                                |

- **Built once, by the workspace session.** `build()` creates it from the session's lifecycle and export manager and exposes it as `Workspace.agentStatements` (ADR 0014). Each MCP server instance, including each HTTP request, gets the same module, and no handler builds anything per call.
- **No path to server-written SQL, by type.** The module depends on `Pick<StatementLifecycle, "submit" | "get" | "cancel">` and on the export manager, so the guarantee of [ADR 0015](0015-review-fixes-for-the-deepened-modules.md) moves from the server's dependency type to the module's. `ServerDependencies.workspace()` gives `agentStatements` instead of `statements` and `exports`. Exports still apply the read-only policy because the export manager submits them through `submitExport`.
- **The row limit does not apply to exports.** `execute` leaves it out of an export request, as the handler did.
- **The tool handlers only translate.** `snake_case` tool arguments (`row_limit`, `warehouse_id`) become the `camelCase` request fields in the handler, because the names are a concern of the MCP schema. Everything after that is the module's.
- **Response shapes and behaviour do not change** (design section 4.1).

Alternatives considered:

- _Keep the name "statement lookup" and add `execute`_: a lookup that submits statements has a name that no longer says what the module is. Rejected.
- _Move the inline-or-export decision into the export manager_: the manager would submit plain statements on the agent's behalf and its interface would grow for callers that only export. Rejected.
- _A second module for `execute` beside the lookup_: the handlers would still wire two modules for one question, "what does the agent do with statements", and the session would build both. Rejected.

## Consequences

- The `execute_sql` and `get_statement` handlers hold no routing logic. The decision is tested through the module's interface with fakes of `statements` and `exports`, and with the real lifecycle and export manager for the read-only policy on both branches (`test/agent-statements.test.ts`).
- `ServerDependencies` shrinks: the server tests build the module from the same fakes as before, and their assertions do not change.
- This ADR supersedes the sentence of ADR 0014 that keeps the lookup in the server, and the name of the module in ADR 0011. The behaviour of `get` and `cancel` in ADR 0011 stands.
