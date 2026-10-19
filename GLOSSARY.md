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
| **Diagnostics**          | `checkMs` and `warehouseId`, filled by the module for the final log entry of a tool call (an out-parameter until the execution scope module replaces it).         |
