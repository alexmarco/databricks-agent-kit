# Glossary

Terms used in the code and the documents of `databricks-agent-kit`. Design vocabulary follows the architecture review of 2026-10-19.

## Design vocabulary

| Term           | Meaning                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Module**     | Anything with an interface and an implementation, at any scale: a function, a file, a slice.                         |
| **Interface**  | Everything a caller must know to use a module correctly: signatures, invariants, ordering, error modes, options.     |
| **Seam**       | The place where a module's interface lives and behaviour can be altered without editing there. Tests cross seams.    |
| **Adapter**    | A concrete thing that satisfies an interface at a seam (the real `DatabricksClient`, or a fake one in tests).        |
| **Depth**      | Behaviour a caller can exercise per unit of interface it has to learn. Deep: much behind a small interface.         |
| **Leverage**   | What callers get from depth: one implementation pays back across many call sites and tests.                          |
| **Locality**   | What maintainers get from depth: change, bugs and verification concentrate in one place.                             |

## Statement lifecycle

| Term                     | Meaning                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Statement lifecycle**  | The module (`src/statements.ts`, ADR 0009) that owns submitting a statement, the read-only policy, polling, cancellation and bounded result shaping.              |
| **Statement**            | One SQL statement submitted to the Databricks Statement Execution API, identified by a statement id.                                                              |
| **Plain statement**      | A statement submitted inline (`INLINE`, `JSON_ARRAY`): its result is bounded and returned to the caller. Opposite of an export.                                   |
| **Export**               | A statement submitted as `EXTERNAL_LINKS` whose full result is downloaded by the export manager to a file (ADR 0003).                                             |
| **Origin**               | Who wrote a statement: the `agent` (`execute_sql`, exports) or the `server` (metadata queries, doctor probes). Only agent statements go through the read-only policy. |
| **Read-only policy**     | The rule of ADR 0008, applied in one place of the module: reject an inner `;`, accept plain leading read commands, otherwise analyse with `DESCRIBE QUERY`.        |
| **Server-written SQL**   | SQL that this server composes itself; it skips the read-only policy.                                                                                              |
| **Poll / wait**          | `get` with `waitSeconds` re-fetches a statement with growing waits (1 s, 2 s, 3 s...) until it is no longer `PENDING` or `RUNNING` or the wait is spent.          |
| **Result shaping**       | Turning an API statement into a bounded result: columns, rows capped by the row limit and the byte limit, and a `truncated` flag.                                 |
| **Await export**         | `awaitExport` polls an export statement until it succeeds, with waits growing to 10 s and no upper bound, and describes its result (ADR 0010). Opposite of the bounded `get` wait. |
| **Chunk link**           | The presigned URL of one result chunk of an export, from `exportChunkLink` or inline with the finished statement. It carries credentials: never logged or returned.   |
| **Statement lookup**     | The module (`src/statement-lookup.ts`, ADR 0011) that answers `get` and `cancel` for any statement id: an id the export manager knows is an export, any other id is a plain statement.        |
| **Diagnostics**          | `checkMs` and `warehouseId`, reported with `scope.annotate` by the statement lifecycle for the final log entry of the current scope (ADR 0012).                   |

## Execution scope

| Term                 | Meaning                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution**        | One recorded unit of work in the log: a tool call, a recorded resource read, a background export, or the server lifecycle. It ends `completed`, `failed` or `cancelled`.                              |
| **Execution scope**  | The module (`src/execution-scope.ts`, ADR 0012) that opens an execution, runs work with it as the current one, writes the single final entry and sets the final status. `scope.run` is its entry point. |
| **Current scope**    | The execution of the running `scope.run` (and its awaits), as `logs.current()` reports it; `scope.annotate` and the log events of the services find their execution through it.                       |
| **Final entry**      | The single entry a scope writes when it ends: `info` on success, `warn` without stack trace for a `DakError`, `error` with stack trace otherwise; same arguments, duration and diagnostics in both. |
| **Cancelled**        | Final status of a scope whose work threw `ExecutionCancelled`; it writes no entry.                                                                                                                   |
