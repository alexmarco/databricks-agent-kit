# Glossary

Terms used in the code and the documents of `databricks-agent-kit`. Design vocabulary follows the architecture review of 2026-10-19.

## Design vocabulary

| Term          | Meaning                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Module**    | Anything with an interface and an implementation, at any scale: a function, a file, a slice.                      |
| **Interface** | Everything a caller must know to use a module correctly: signatures, invariants, ordering, error modes, options.  |
| **Seam**      | The place where a module's interface lives and behaviour can be altered without editing there. Tests cross seams. |
| **Adapter**   | A concrete thing that satisfies an interface at a seam (the real `DatabricksClient`, or a fake one in tests).     |
| **Depth**     | Behaviour a caller can exercise per unit of interface it has to learn. Deep: much behind a small interface.       |
| **Leverage**  | What callers get from depth: one implementation pays back across many call sites and tests.                       |
| **Locality**  | What maintainers get from depth: change, bugs and verification concentrate in one place.                          |

## Statement lifecycle

| Term                    | Meaning                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Statement lifecycle** | The module (`src/statements.ts`, ADR 0009) that owns submitting a statement, the read-only policy, polling, cancellation and bounded result shaping.                                                                  |
| **Statement**           | One SQL statement submitted to the Databricks Statement Execution API, identified by a statement id.                                                                                                                  |
| **Plain statement**     | A statement submitted inline (`INLINE`, `JSON_ARRAY`): its result is bounded and returned to the caller. Opposite of an export.                                                                                       |
| **Export**              | A statement submitted as `EXTERNAL_LINKS` whose full result is downloaded by the export manager to a file (ADR 0003).                                                                                                 |
| **Agent statement**     | A statement the agent wrote (`execute_sql`, exports): `submit` and `submitExport` always put it through the read-only policy unless writes are allowed (ADR 0015).                                                    |
| **Read-only policy**    | The rule of ADR 0008, applied in one place of the module: reject an inner `;`, accept plain leading read commands, otherwise analyse with `DESCRIBE QUERY`.                                                           |
| **Server-written SQL**  | SQL that this server composes itself (metadata queries, doctor probes); it skips the read-only policy through `query` or `submitServerSql`, which the tool handlers never receive.                                    |
| **Poll / wait**         | `get` with `waitSeconds` re-fetches a statement with growing waits (1 s, 2 s, 3 s...) until it is no longer `PENDING` or `RUNNING` or the wait is spent.                                                              |
| **Result shaping**      | Turning an API statement into a bounded result: columns, rows capped by the row limit and the byte limit, and a `truncated` flag.                                                                                     |
| **Await export**        | `awaitExport` polls an export statement until it succeeds, with waits growing to 10 s and no upper bound, and describes its result (ADR 0010). Opposite of the bounded `get` wait.                                    |
| **Chunk link**          | The presigned URL of one result chunk of an export, from `exportChunkLink` or inline with the finished statement. It carries credentials: never logged or returned.                                                   |
| **Agent statements**    | The module (`src/agent-statements.ts`, ADR 0011 and 0023) for the agent's statements: `execute` (inline, or an export when asked), and `get` and `cancel` for any statement id, export or plain.                      |
| **Warehouse selection** | The module (`src/warehouses.ts`, ADR 0012) that owns which SQL warehouse is used: `resolve(explicit?)` and `list()`. Rule order: explicit, configured, automatic.                                                     |
| **Automatic choice**    | The warehouse picked when none is explicit or configured: a running one, else a serverless one, else the first accessible. Remembered once made and reported once with its reason (`running`, `serverless`, `first`). |
| **Diagnostics**         | `checkMs` and `warehouseId`, reported with `scope.annotate` by the statement lifecycle for the final log entry of the current scope (ADR 0013).                                                                       |

## Execution scope

| Term                | Meaning                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution**       | One recorded unit of work in the log: a tool call, a recorded resource read, a background export, or the server lifecycle. It ends `completed`, `failed` or `cancelled`.                                |
| **Execution scope** | The module (`src/execution-scope.ts`, ADR 0013) that opens an execution, runs work with it as the current one, writes the single final entry and sets the final status. `scope.run` is its entry point. |
| **Current scope**   | The execution of the running `scope.run` (and its awaits), as `logs.current()` reports it; `scope.annotate` and the log events of the services find their execution through it.                         |
| **Final entry**     | The single entry a scope writes when it ends: `info` on success, `warn` without stack trace for a `DakError`, `error` with stack trace otherwise; same arguments, duration and diagnostics in both.     |
| **Cancelled**       | Final status of a scope whose work threw `ExecutionCancelled`; it writes no entry.                                                                                                                      |

## Workspace session

| Term                     | Meaning                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Workspace session**    | The module (`src/workspace-session.ts`, ADR 0014) that owns lazy credential resolution, construction of the Databricks modules from settings, their log hooks and closing. `createWorkspaceSession` is the server's entry point.                                                     |
| **Workspace**            | What `session.workspace()` gives: the credentials (`auth`), `client`, `warehouses`, `statements`, `metadata` and `exports` of one session, built once and reused.                                                                                                                    |
| **Workspace connection** | The part of the workspace that `connectWorkspace` builds without a log service: `auth`, `client`, `warehouses` and `statements`. `dak doctor` uses it with its smaller `DOCTOR_LIMITS`.                                                                                              |
| **Adapters**             | The `WorkspaceAdapters` of a session: `resolveAuth`, `createClient`, `fetch` and `sleep`, real in `src/cli.ts` and fakes in tests.                                                                                                                                                   |
| **Closing**              | `session.close()`: waits for a build in flight, cancels the running exports and their Databricks statements and refuses later `workspace()` calls and export starts (ADR 0015); it never resolves credentials, so a session that created nothing closes without touching Databricks. |

## Metadata cache

| Term               | Meaning                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Metadata cache** | The module (`src/metadata-cache.ts`, ADR 0021) that keeps the answers of `describe_table` and `list_objects` in `cache.db` and decides whether a lookup is served from it or loaded from Databricks. |
| **Cache entry**    | One cached answer, keyed by cache identity, kind and lowercase key. Kind `table` holds a table description; kind `listing` holds the full listing of one level (catalogs, schemas or tables).        |
| **Cache identity** | The local SHA-256 of host, authentication method and the credential that identifies the principal (PAT token, M2M `client_id`, U2M profile name). Entries and statistics never cross identities.     |
| **TTL**            | How long an entry is fresh after it was loaded (`DAK_CACHE_TTL`, 24 h by default). Computed at read time; `0` disables the cache.                                                                    |
| **Disabled cache** | The adapter (`disabledMetadataCache`, ADR 0024) that stands for the cache when the TTL is `0`: it stores nothing, every lookup loads, and its answers carry no `cache` field.                        |
| **Load / reload**  | Fetching an answer from Databricks and storing it. A reload replaces an existing entry and is counted as changed or unchanged by comparing the new value with the stored one.                        |
| **Cache status**   | How an answer was served, in its `cache` field: `hit` (fresh entry), `miss` (no entry), `expired` (reloaded after the TTL), `refreshed` (reload forced with `refresh`), `bypassed` (cache failed).   |
| **Refresh**        | `refresh: true` on a cached tool: skips the entry and replaces it with the fresh answer.                                                                                                             |
| **Purge**          | Deleting the entries unused for 30 days, at startup and every 24 h.                                                                                                                                  |
