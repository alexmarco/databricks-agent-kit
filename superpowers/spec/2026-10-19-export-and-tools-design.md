# Result export, minimal tools and logging policy

Status: Approved and implemented (2026-10-19). Reference design: [docs/design.md](../../docs/design.md). Decisions: [docs/adr](../../docs/adr/README.md).

## 1. Goal

Make `dak` usable for queries with very large results without flooding the agent's context, spending few tokens per call, and leaving enough logs to analyze its behavior.

Verifiable success criteria:

- A query with millions of rows is exported to a file without returning rows to the agent.
- The tool definitions take half or less of the current ones (1155 tokens with `o200k_base`). The implementation checks it as a budget of 2500 characters of JSON (`JSON.stringify(tools).length`) against 4944 before, and measures 2384 (2269 with writes enabled).
- Every export ends with a complete file or with no visible file at all.
- An expected failure (write in read-only mode, missing table) does not show up as an error in the logs.
- The only new dependency is `parquet-wasm`.

## 2. Decisions

| Topic                     | Decision                                                                      | ADR                                                       |
| ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| Databricks access         | Public REST API only; no official SDK or drivers                              | [0001](../../docs/adr/0001-rest-api-without-sdk.md)       |
| Query output              | Columnar JSON (`columns` and `rows`), unchanged                               | [0002](../../docs/adr/0002-columnar-output-format.md)     |
| Large results             | Export with `EXTERNAL_LINKS`: CSV, Parquet and SQLite, in the background      | [0003](../../docs/adr/0003-export-with-external-links.md) |
| Parquet                   | Convert `ARROW_STREAM` chunks with `parquet-wasm`                             | [0004](../../docs/adr/0004-parquet-with-parquet-wasm.md)  |
| ADBC and Arrow Flight SQL | Not adopted for now                                                           | [0005](../../docs/adr/0005-do-not-adopt-adbc.md)          |
| Tool surface              | 5 tools                                                                       | [0006](../../docs/adr/0006-minimal-mcp-surface.md)        |
| Logging                   | Levels, correlation and privacy rules of section 7                            | [0007](../../docs/adr/0007-logging-policy.md)             |
| Read-only check           | Simplified, see section 6                                                     | [0008](../../docs/adr/0008-simplified-read-only-check.md) |
| Partitioning by column    | Discarded                                                                     | [0003](../../docs/adr/0003-export-with-external-links.md) |
| Export settings           | `DAK_EXPORT_DIR` and `DAK_EXPORT_MAX_BYTES`, with the defaults of section 5.2 | This document                                             |
| Language of the documents | English, because the repository will be published on GitHub                   | This document                                             |

## 3. MCP surface

Five tools instead of the current twelve:

| Tool              | Input                                                                                       | Replaces                                                         |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `list_objects`    | `catalog?`, `schema?`, `pattern?`, `limit?`                                                 | `list_catalogs`, `list_schemas`, `list_tables`                   |
| `describe_table`  | `full_name`, `sample_rows?`, `lineage?`                                                     | `describe_table`, `sample_table`, `table_lineage`                |
| `search_metadata` | `query`, `catalog?`, `limit?`                                                               | Unchanged                                                        |
| `execute_sql`     | `statement`, `parameters?`, `catalog?`, `schema?`, `row_limit?`, `warehouse_id?`, `export?` | `execute_sql` and the export                                     |
| `get_statement`   | `statement_id`, `wait_seconds?`, `cancel?`                                                  | `get_statement`, `cancel_statement` and the follow-up of exports |

The resources become `resource://databricks/warehouses` (replaces `list_warehouses`) and the existing `resource://logs/*`. The `search_logs` tool is removed because the resources cover diagnosis without spending context until they are read.

`list_objects` without arguments lists catalogs; with `catalog`, schemas; with `catalog` and `schema`, tables. The three listings accept `limit` and return `truncated`.

## 4. Query output

Unchanged: `{ columns: [{ name, type }], rows: [[...]], rowCount, truncated, statementId }` with values as text and `null` for SQL `NULL`. Measured on 100 rows and 8 columns, it costs 5555 tokens against 7966 for an array of objects. `BIGINT` and `DECIMAL` stay as text so no precision is lost.

`get_statement` uses `DAK_MAX_ROWS` as its row cap, not 100, because Databricks already applied the `row_limit` of the original query.

## 5. Export

### 5.1 Usage

`execute_sql` accepts `export: { format, name? }` with `format` equal to `csv`, `parquet` or `sqlite`. With `export`:

- `row_limit` and `DAK_MAX_ROWS` do not apply; the limit is `DAK_EXPORT_MAX_BYTES`, sent as `byte_limit`.
- The response is immediate: `{ statementId, state: "PENDING", export: { id, statementId, format, path, status } }`.
- The read-only check applies exactly as it does without `export`.

`get_statement` returns the export state: `PENDING` (the query is still running in Databricks), `DOWNLOADING` with `{ chunksDone, chunksTotal, rows, bytes }`, `SUCCEEDED` with `{ files, rows, bytes }`, `FAILED` with the reason, or `CANCELED`. With `wait_seconds` it waits up to that time (30 s at most) before answering. With `cancel: true` it stops the local job, which deletes the partial files, and cancels the query in Databricks; the answer is `{ statementId, cancelled: true }`.

### 5.2 Destination and settings

Every export is written under `DAK_EXPORT_DIR`. The agent never chooses a path, only an optional `name`, sanitized to `[A-Za-z0-9._-]` and at most 64 characters. The identifier is `<name or "export">-<full statement_id>`, the statement id sanitized to the same characters and not cut: Databricks statement ids are time-ordered, so their first characters are shared by statements submitted minutes apart.

| Setting          | Environment            | Default                              |
| ---------------- | ---------------------- | ------------------------------------ |
| Export directory | `DAK_EXPORT_DIR`       | `<per-user state directory>/exports` |
| Export size cap  | `DAK_EXPORT_MAX_BYTES` | 10 GiB                               |

| Format    | Result                            | Detail                                                |
| --------- | --------------------------------- | ----------------------------------------------------- |
| `csv`     | `<id>.csv`                        | A single file, however many chunks Databricks returns |
| `parquet` | `<id>/part-00000.parquet`, ...    | One file per chunk, written into `<id>.part/`         |
| `sqlite`  | `<id>.db` with the table `result` | A single file                                         |

Each output is written under a `.part` name (`<id>.csv.part`, `<id>.db.part`, and the directory `<id>.part/` for Parquet) and renamed when it is complete, so an unfinished export never looks finished; for Parquet the whole directory is renamed to `<id>`. Outside Windows, the directory is created with mode `0700`; the files keep the default permissions of the process, protected by that directory. A relative `DAK_EXPORT_DIR` is resolved against the working directory of the server process. If the target path already exists, or an export for it is running, the call is rejected ("already exists; choose another name") and the statement just submitted is cancelled.

### 5.3 Flow

1. The query is submitted with `disposition: EXTERNAL_LINKS` and the format each output needs: `CSV`, `ARROW_STREAM` or `JSON_ARRAY`.
2. The job polls the statement (waits of 1 s growing to 10 s) until it has finished, then reads the chunk count from the `manifest`. The link of the first chunk comes with the result; for each other chunk a fresh URL is requested from `/result/chunks/{n}` right before downloading it, because URLs expire after 15 minutes at most.
3. Downloads are plain `GET` requests without an `Authorization` header, at most 4 in parallel and at most 8 chunks ahead of the one being written. A network error, `429` or `5xx` is retried up to 3 times, with waits of 500, 1000 and 2000 ms. An expired link or a `403` gets one fresh URL. Any other status fails the export, and the first failure aborts the job at once.
4. Each format processes the chunks as described below.

**CSV.** Chunks are written in `chunk_index` order; chunks that arrive early wait in memory (at most 8 ahead). Only the first one has a header, so the concatenation is a valid CSV. SQL `NULL` is written as the text `null`, unquoted, and cannot be told apart from the string `"null"`; the README documents it.

**Parquet.** Each `ARROW_STREAM` chunk is a complete Arrow IPC stream with its own schema and no LZ4 compression. It is handed to `parquet-wasm` without being interpreted and written with ZSTD and the other options at their defaults. `DECIMAL`, `TIMESTAMP`, `STRUCT` and `ARRAY` are preserved.

**SQLite.** `JSON_ARRAY` chunks are read and inserted with `node:sqlite`, one transaction per chunk and one prepared statement. Values are bound as text and SQLite converts them according to the column affinity.

| Databricks type                        | SQLite column    | Conversion                                 |
| -------------------------------------- | ---------------- | ------------------------------------------ |
| `TINYINT`, `SMALLINT`, `INT`, `BIGINT` | `INTEGER`        | None; `BIGINT` stays exact                 |
| `BOOLEAN`                              | `INTEGER`        | `"true"` becomes 1 and `"false"` becomes 0 |
| `FLOAT`, `DOUBLE`                      | `REAL`           | None                                       |
| `DECIMAL` of 15 digits or fewer        | `REAL`           | None                                       |
| `DECIMAL` of more than 15 digits       | `TEXT`           | None, to avoid losing precision            |
| `DATE`, `TIMESTAMP`, `STRING`          | `TEXT`           | None; dates in ISO 8601                    |
| `STRUCT`, `ARRAY`, `MAP`               | `TEXT` with JSON | None; query them with `json_extract`       |
| Others, such as `BINARY` and intervals | `TEXT`           | None                                       |

No PRAGMAs and no multi-row inserts: measured with a real chunk, they did not improve the ~950,000 rows per second of insertion. The dominant cost is `JSON.parse` (about 305 ms per chunk of 125,000 rows).

### 5.4 Limits

- Exports live in the process. If it restarts, the job is lost and `dak` does not resume it; Databricks keeps the result for about 12 hours, so it can be requested again.
- `dak` does not delete finished exports. At startup `dak mcp` removes the `.part` files and directories of the export directory that are older than 24 hours (`cleanupOrphanedParts`); this needs no credentials, so it runs in the background without waiting for the first tool call. On a clean shutdown every running export is cancelled and its partial files are deleted.
- In HTTP mode the files are written on the server machine.
- Presigned links point to cloud storage, not to the workspace host. A proxy or firewall can block them; `dak doctor` checks it (check **Result download**: a `SELECT 1` export whose first link is downloaded without credentials; a failure is a warning). The check **Export directory** fails when the directory cannot be created or written.
- Anyone with access to the file system can read what was exported.

## 6. Read-only check

The check is simplified (ADR 0008):

- First, a statement that holds a `;` before its last non-whitespace character is rejected without any call, so the `DESCRIBE QUERY` check can never submit several statements. Read-only mode cannot tell several statements from a `;` inside a literal; the message tells the agent to pass such literals as `:name` parameters (and mentions `--allow-writes`). A single trailing `;` is accepted.
- A statement that starts with `SHOW`, `DESCRIBE`, `DESC` or `EXPLAIN` as a whole word, preceded only by spaces, tabs or line breaks, not followed by a `:` (a SQL-scripting label), and that holds no `;` except at the end, is accepted without an extra call. Comments are not skipped.
- All others, including any statement that starts with a comment, must pass `DESCRIBE QUERY`, which only accepts queries. A parse error becomes a read-only violation whose message suggests removing a leading comment.
- The analysis of the `EXPLAIN` plan is removed, since it depends on internal Databricks texts.

## 7. Logging

Principles: structured events, correlation by identifier, levels with meaning, and nothing that will not be analyzed.

| Change                      | Detail                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expected errors             | `DakError`s (read-only mode, invalid argument, `PERMISSION_DENIED`, bad SQL) are stored as `warn`, without a stack trace. Only unexpected errors are `error` with a stack trace                                                                                                                    |
| One entry per call          | Written when the call ends: tool, arguments, duration, `statementId`, `warehouseId`, state, rows and `truncated`. A failed call writes one entry too, not two: `ExecutionHandle.fail(error, metadata?)` logs the error with the same fields. If the process dies, the execution stays as `started` |
| Arguments                   | The SQL is stored, truncated to 4 KB. For parameters only the name and type are stored, not the value                                                                                                                                                                                              |
| Log queries                 | Reading `resource://logs/*` does not open executions, so statistics are not inflated                                                                                                                                                                                                               |
| Retries                     | `warn` for every retry: HTTP status, attempt and wait                                                                                                                                                                                                                                              |
| Warehouse and token         | `info` once when the automatic warehouse is chosen, with the reason; `debug` on every token refresh                                                                                                                                                                                                |
| Read-only check             | Its duration goes in the final entry of `execute_sql` (`checkMs`)                                                                                                                                                                                                                                  |
| HTTP requests to Databricks | `debug` with method, path without identifiers, status and milliseconds; off at the default `info` level                                                                                                                                                                                            |
| Export                      | Its own execution. `info` at start and end (format, rows, chunks, bytes, duration); `warn` on download retries and link renewals; a failure follows the first row (`warn` for a `DakError`, `error` otherwise); per-chunk detail only at `debug`                                                   |
| HTTP `401` rejections       | `warn`, at most once a minute with a counter of suppressed events; never the token or headers                                                                                                                                                                                                      |

## 8. Included fixes

They come from the 2026-10-19 review and were verified with a reproduction script:

- An internal query that does not finish within 30 s returned empty results without any warning (`search_metadata`, tags of `describe_table`, the former `table_lineage`). It is now cancelled and the error says the warehouse may be starting.
- `get_statement` returned at most 100 rows even if the original query asked for more.
- The listings had no output limit.
- API requests had no timeout and `Retry-After` had no cap.

Left for later: concurrent token refresh, cache of the automatic warehouse, `DATABRICKS_*` variables inherited by the CLI, annotations of the former `cancel_statement` and of `execute_sql`, ordering and escaping in `search_metadata`, parallel lineage queries, and invalid dates in the log queries.

## 9. Verification

| Level       | What                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | SQLite type mapping, ordered CSV concatenation, atomic rename, `name` sanitizing, log levels by error type, SQL truncation, size of the tool definitions                                     |
| End to end  | Test server with presigned links on another origin: no `Authorization` header is sent, an expired link is renewed, cancellation works and no partial files remain                            |
| Integration | Against a real workspace, guarded by `DAK_IT_PROFILE`: multi-chunk CSV, Arrow to Parquet with `NULL`, `DATE`, `BINARY` and `MAP`, `byte_count` against the downloaded size, and cancellation |

Everything is developed test-first: each step starts with the test that reproduces the failure or the new behavior.

## 10. Out of scope

- Partitioning by column.
- The official JavaScript SDK and SQL driver, ADBC and Arrow Flight SQL.
- Arrow in `INLINE` mode and the undocumented `INLINE_OR_EXTERNAL_LINKS` mode.
- Resuming exports after a restart.
