# Result Export, Minimal Tools and Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the MCP surface to 5 tools, add background export of large results to CSV, Parquet and SQLite, simplify the read-only check, and apply the logging policy of the spec.

**Architecture:** Existing services (`client`, `sql`, `metadata`, `logging`) are extended in place. A new `src/export/` package downloads `EXTERNAL_LINKS` chunks through an `ExportManager` that feeds one `ChunkSink` per format. `server.ts` exposes the 5 tools and wraps every call in one log execution; `cli.ts` wires the pieces lazily as today.

**Tech Stack:** TypeScript on Node.js >= 22.13 (ESM, `.ts` imports, `erasableSyntaxOnly`), `node:test`, `node:sqlite`, `zod`, `@modelcontextprotocol/server`, and one new dependency, `parquet-wasm` 0.9.0 (approved).

**Spec:** [superpowers/spec/2026-10-19-export-and-tools-design.md](../spec/2026-10-19-export-and-tools-design.md). Decisions: [docs/adr](../../docs/adr/README.md). Executors read both.

**No commit steps.** The working tree already holds 25 uncommitted files from earlier work. After every task passes, the user structures branches and commits in a separate stage. Do not commit, branch or push while executing this plan.

## Global Constraints

- Node.js `>=22.13`; TypeScript `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums, no parameter properties); relative imports end in `.ts`.
- The only new dependency is `parquet-wasm`, installed with `npm install --save-exact parquet-wasm@0.9.0` and imported from `parquet-wasm/node`. Ask before adding anything else.
- Databricks access is `fetch` against public REST APIs only (ADR 0001). Presigned chunk URLs are downloaded with plain `GET` and no `Authorization` header.
- Tool count is 5: `list_objects`, `describe_table`, `search_metadata`, `execute_sql`, `get_statement`. `JSON.stringify(tools).length` must be at most 2500 characters (the 12 original tools take 4944).
- Query output stays `{ columns: [{ name, type }], rows, rowCount, truncated, statementId }` with text values (ADR 0002).
- Exports are written only under `DAK_EXPORT_DIR` (default `<storageDir>/exports`); `DAK_EXPORT_MAX_BYTES` defaults to `10 * 1024 ** 3` and is sent as `byte_limit`. The agent only supplies an optional `name`.
- Export concurrency is 4 downloads; a chunk is requested again at most once when its link has expired; each file is written as `.part` and renamed on success.
- Logging: `DakError` is logged as `warn` without stack trace, other errors as `error` with stack; SQL is cut at 4096 characters; parameter values are never logged; `resource://logs/*` reads open no execution; nothing is written to stdout in stdio mode.
- All code, comments and documents are in English. Tests run with `node --disable-warning=ExperimentalWarning --test test/<file>.test.ts`.

## Review Focus

1. A write hidden behind a nested comment after a read-only prefix, such as `/* /* */ SHOW */ DROP TABLE t`, must be rejected (Task 4).
2. An export of zero rows must still produce a readable result: CSV with only the header, SQLite with an empty `result` table, Parquet as an empty directory (Tasks 8 to 11).
3. A result cut by `DAK_EXPORT_MAX_BYTES` must finish as `SUCCEEDED` with `truncated: true`, never look complete (Task 11).
4. Cancelling or closing the manager in the middle of a download must leave no `.part` file or directory and stop in-flight downloads (Task 11).
5. Hostile text must not escape its slot: an export `name` such as `../../x` or an empty string, and SQLite column names with quotes or spaces (Tasks 7 and 9).

---

## Deviations from this plan

What the implementation does differently from the tasks below:

- **Task 4:** the planned `firstKeyword` scanner (nested comments) was replaced by the strict `isReadCommand` rule: a read command runs without a check only when it is the first word and the statement holds no inner `;`; everything else, including any statement that starts with a comment, goes through `DESCRIBE QUERY` (ADR 0008).
- **Task 12:** the `$schema` URI that `zod` adds to every tool input schema is stripped, which was needed to meet the 2500-character budget (2384 measured).
- **Task 1 and the export manager:** a relative `DAK_EXPORT_DIR` is resolved against the working directory when the export manager is created.
- **Task 11:** after `submitExport` the manager checks the target path; if it already exists, it cancels the statement that was just rejected and fails the call.
- **Task 11:** downloads retry up to 3 times (500, 1000 and 2000 ms) on network errors, `429` and `5xx`, in addition to the single link renewal on `403` or an expired link.
- **Task 13:** `cleanupOrphanedParts` runs at startup in `dak mcp`, in the background and without credentials.

---

## File Structure

| File                                         | Responsibility                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/config.ts`                              | Adds `exportDir` and `exportMaxBytes` settings                                      |
| `src/client.ts`, `src/auth.ts`               | Request timeout, `Retry-After` cap, retry/request/refresh hooks                     |
| `src/logging/service.ts`                     | Error levels, `current()` and `run()` execution scope                               |
| `src/logging/arguments.ts` (new)             | `describeArguments`: loggable form of tool arguments                                |
| `src/logging/rate-limit.ts` (new)            | `createRateLimitedLogger`                                                           |
| `src/sql.ts`                                 | Simplified read-only check, `runQuery`, `getStatement` options, `submitExport`      |
| `src/metadata.ts`                            | `listObjects`, `describeTable` with sample and lineage                              |
| `src/export/types.ts` (new)                  | Export types shared by sinks and manager                                            |
| `src/export/paths.ts` (new)                  | Name sanitizing, export id and path                                                 |
| `src/export/csv-sink.ts` (new)               | Ordered CSV concatenation                                                           |
| `src/export/sqlite-sink.ts` (new)            | JSON chunks into a SQLite table                                                     |
| `src/export/parquet-sink.ts` (new)           | Arrow chunks into Parquet files                                                     |
| `src/export/manager.ts` (new)                | Background jobs: polling, downloads, ordering, progress, cancel                     |
| `src/server.ts`                              | 5 tools, resources, one log entry per call                                          |
| `src/cli.ts`, `src/http.ts`, `src/doctor.ts` | Wiring, rate-limited `401` warning, export checks                                   |
| `test/fixtures/sample.arrows` (exists)       | Arrow IPC stream of 3 rows (`id` int64, `amount` float64, `label` utf8 with a null) |

---

### Task 1: Export settings

**Files:**

- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**

- Produces: `Settings.exportDir: string` and `Settings.exportMaxBytes: number`.

- [ ] **Step 1: Write failing tests** in `test/config.test.ts`:
  - `resolveSettings({}, {}, "/state")` gives `exportDir` equal to `join("/state", "exports")` and `exportMaxBytes` equal to `10 * 1024 ** 3`.
  - `DAK_EXPORT_DIR=/data/x` and `DAK_EXPORT_MAX_BYTES=5000` override both; with `DAK_STORAGE_DIR=/s` and no `DAK_EXPORT_DIR` the directory is `join("/s", "exports")`.
  - `DAK_EXPORT_MAX_BYTES=0` throws `ConfigError` matching `/DAK_EXPORT_MAX_BYTES/`.
- [ ] **Step 2: Run** `node --disable-warning=ExperimentalWarning --test test/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two fields in `Settings` and `resolveSettings` using the existing `parsePositiveInteger`.
- [ ] **Step 4: Run** the same command plus `npm run typecheck`. Expected: config tests pass; typecheck lists every literal `Settings` in tests (for example `test/doctor.test.ts`) that now needs the two fields; add them.

### Task 2: Client resilience and observability hooks

**Files:**

- Modify: `src/client.ts`, `src/auth.ts`
- Test: `test/client.test.ts`, `test/auth.test.ts`

**Interfaces:**

- Produces in `src/client.ts`:
  - `interface RetryEvent { method: "GET" | "POST"; path: string; attempt: number; delayMs: number; status?: number; error?: string }`
  - `interface RequestEvent { method: "GET" | "POST"; path: string; status: number; ms: number }`
  - `ClientDependencies` gains optional `onRetry?(event: RetryEvent): void`, `onRequest?(event: RequestEvent): void`, `now?(): number` (default `Date.now`).
  - `export function redactPath(path: string): string`: replaces every path segment that contains a `.` or is 8 or more characters with a digit by `:id`, and drops the query string.
- Produces in `src/auth.ts`: `AuthDependencies.onRefresh?(method: AuthMethod): void`, called each time an OAuth token is fetched.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write failing tests** in `test/client.test.ts`:
  - every `fetch` call receives `init.signal` that is an `AbortSignal`.
  - a fetch that throws a `TimeoutError` (`DOMException` named `TimeoutError`) on POST rejects with `DakError` whose message matches `/timed out/`; on GET it is retried.
  - a `Retry-After: 3600` response sleeps exactly `30_000` ms.
  - `onRetry` receives `{ method: "GET", attempt: 0, status: 503 }` for a retried 503; `onRequest` receives the final status and a numeric `ms` using the injected `now`.
  - `redactPath("/api/2.0/sql/statements/01f0abcd-1234/result/chunks/3?x=1")` equals `"/api/2.0/sql/statements/:id/result/chunks/3"` and `redactPath("/api/2.1/unity-catalog/tables/main.sales.orders")` ends in `/tables/:id`.
  - in `test/auth.test.ts`: an M2M and a U2M provider call `onRefresh` once per fetched token and not on cache hits.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Constants `REQUEST_TIMEOUT_MS = 60_000` and `MAX_RETRY_DELAY_MS = 30_000`; pass `signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)` to every fetch; map timeouts to `new DakError("DATABRICKS_API", "Request to <redacted path> timed out after 60 s")` after retries are exhausted; call the hooks.
- [ ] **Step 4: Run** both files and `npm run typecheck`. Expected: PASS.

### Task 3: Logging service, argument description and rate limit

**Files:**

- Modify: `src/logging/service.ts`
- Create: `src/logging/arguments.ts`, `src/logging/rate-limit.ts`
- Test: `test/logging-service.test.ts`, `test/logging-arguments.test.ts`, `test/logging-rate-limit.test.ts`

**Interfaces:**

- Produces:
  - `LogService.current(): ExecutionHandle` (the execution of the running `run()` scope, else `lifecycle`) and `LogService.run<T>(execution: ExecutionHandle, work: () => Promise<T>): Promise<T>` (uses `AsyncLocalStorage`).
  - `ExecutionHandle.fail(error)` now logs `warn` with the message and no stack for `DakError`, `error` with stack otherwise; status is `failed` in both cases.
  - `describeArguments(args: Record<string, unknown>): Record<string, unknown>`: cuts a string `statement` to 4096 characters followed by `…[+N chars]` and replaces `parameters` by `[{ name, type }]`.
  - `createRateLimitedLogger(emit: (suppressed: number) => void, intervalMs: number, now: () => number): () => void`.

- [ ] **Step 1: Write failing tests:**
  - service: `fail(new ReadOnlyViolationError("x"))` leaves a `warn` entry with no `stackTrace`; `fail(new Error("boom"))` leaves an `error` entry with `stackTrace`; both executions end `failed`.
  - service: inside `await logs.run(handle, async () => { await Promise.resolve(); return logs.current(); })` the result is `handle`; outside it is `logs.lifecycle`.
  - arguments: a 5000-character `statement` is cut to 4096 characters plus the suffix `…[+904 chars]`; `parameters: [{ name: "id", value: "secret", type: "INT" }]` becomes `[{ name: "id", type: "INT" }]`; other keys pass through.
  - rate limit: with intervalMs 60000, calls at t=0, 10, 20 emit once (`0`) and at t=70 emit `2`.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement** the three units; `fail` must import `DakError` from `../errors.ts`.
- [ ] **Step 4: Run** the three files, then `test/server.test.ts`. Expected: the logging tests pass; `test/server.test.ts:87` fails because a `SqlError` is now `warn` without stack. Change it to expect `level === "warn"` and no `stackTrace`, and add a case where the fake service throws a plain `Error` and the log has `level === "error"` with a stack containing `Error`.

### Task 4: Simplified read-only check

**Files:**

- Modify: `src/sql.ts`
- Test: `test/sql.test.ts`

This task was first planned with a comment-skipping `firstKeyword`; review replaced that design with the strict rule below (see "Deviations from this plan" and ADR 0008). The text describes what was built.

**Interfaces:**

- Produces: `export function isReadCommand(statement: string): boolean`, true when the statement starts, after spaces, tabs and line breaks only, with `SHOW`, `DESCRIBE`, `DESC` or `EXPLAIN` as a whole word (case-insensitive) and holds no `;` except at the end. Comments are not skipped.
- Removes: `physicalPlanRoot`, `isReadOnlyCommand` and the `EXPLAIN` branch of `assertReadOnly`, with their tests and fixtures (`READ_COMMANDS`, `WRITE_COMMANDS`, `plan`, `explained`).

- [x] **Step 1: Write failing tests:**
  - `isReadCommand`: accepts `SHOW TABLES`, `describe t`, `DESC t`, `EXPLAIN SELECT 1`, with leading blanks and a trailing `;`; rejects any leading comment, including `/* /* */ SHOW */ DROP TABLE t`, a `--` comment ended by a bare carriage return or continued by a backslash, identifiers that merely start with the keyword (`SHOW_x`, `SHOW1`, `SHOWé`), Unicode blanks other than spaces, tabs and line breaks, `SHOW TABLES; DROP TABLE t` and statements that are not read commands.
  - Fast path: `SHOW TABLES` and `EXPLAIN SELECT 1` run with exactly one API call (the statement itself).
  - A query goes through `DESCRIBE QUERY` and then runs (two calls, same body fields as the existing test).
  - Statements that only look like reads are rejected through `DESCRIBE QUERY` and never submitted.
  - A statement that starts with a comment is rejected with a `ReadOnlyViolationError` whose message tells the agent to remove the comment.
  - A `PARSE_SYNTAX_ERROR` from `DESCRIBE QUERY` rejects with `ReadOnlyViolationError` whose message contains the Databricks message and `--allow-writes`; any other failure (for example `TABLE_OR_VIEW_NOT_FOUND`) rejects with `SqlError` and one call; a `CANCELED` check rejects with `/warehouse may still be starting/`.
  - `allowWrites: true` and `runStatement` skip the check (existing test kept).
- [x] **Step 2: Run** `test/sql.test.ts`. Expected: FAIL.
- [x] **Step 3: Implement** `isReadCommand` with one anchored regular expression for the start and one check for inner `;`, and `assertReadOnly(body, diagnostics?)`: a read command passes without a call; anything else is checked with `DESCRIBE QUERY`, and a parse error becomes `ReadOnlyViolationError`. Keep `ReadOnlyViolationError`.
- [x] **Step 4: Run** `test/sql.test.ts` and `npm run typecheck`. Expected: PASS.

### Task 5: SQL service additions

**Files:**

- Modify: `src/sql.ts`
- Test: `test/sql.test.ts`

**Interfaces:**

- Consumes: `ExportFormat` from `src/export/types.ts` (created in Task 7; for this task declare `type ExportFormat = "csv" | "parquet" | "sqlite"` locally in `src/sql.ts` and replace it by an import in Task 7).
- Produces:
  - `interface ExecutionDiagnostics { checkMs?: number }`; `executeSql(request: ExecuteSqlRequest, diagnostics?: ExecutionDiagnostics): Promise<StatementResult>` fills `checkMs` when the check ran.
  - `runQuery(request: ExecuteSqlRequest): Promise<StatementResult>`: like `runStatement` but cancels a statement still `PENDING` or `RUNNING` and throws `SqlError` matching `/did not finish.*warehouse may be starting/`.
  - `getStatement(statementId: string, options?: { rowLimit?: number; waitSeconds?: number }): Promise<StatementResult>`: default `rowLimit` is `options.maxRows`; `waitSeconds` (clamped to 0..30) polls with waits of 1 s, 2 s, 3 s... until the state is terminal or the time is spent.
  - `SqlServiceOptions` gains optional `maxExportBytes?: number`, `sleep?(ms: number): Promise<void>`, `now?(): number` and `onWarehouseChosen?(event: { warehouseId: string; name: string; reason: "running" | "serverless" | "first" }): void`.
  - `submitExport(request: ExecuteSqlRequest, format: ExportFormat): Promise<{ statementId: string; warehouseId: string }>`: runs the read-only check unless writes are allowed, then posts the statement with `disposition: "EXTERNAL_LINKS"`, `format` `CSV` / `ARROW_STREAM` / `JSON_ARRAY` for `csv` / `parquet` / `sqlite`, `wait_timeout: "0s"`, `on_wait_timeout: "CONTINUE"`, `byte_limit: maxExportBytes ?? 10 * 1024 ** 3` and no `row_limit`; a `FAILED` response throws `SqlError`.

- [ ] **Step 1: Write failing tests:** `runQuery` on a `RUNNING` response posts a cancel to `/api/2.0/sql/statements/st1/cancel` and rejects; `getStatement("st1")` with 500 stub rows returns 500 rows when `maxRows` is 1000 (regression for the old 100 cap); `getStatement` with `waitSeconds: 5` and a stub that answers `RUNNING` twice then `SUCCEEDED` returns the result and the injected `sleep` received `[1000, 2000]`; `submitExport` posts exactly the body above (assert each field) and returns the ids; `submitExport` in read-only mode rejects `DELETE FROM t` before posting the export; `onWarehouseChosen` fires once with `reason: "serverless"` for the existing serverless fixture; `executeSql` fills `diagnostics.checkMs` as a number for a query.
- [ ] **Step 2: Run** `test/sql.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `StatementBody` becomes `disposition: "INLINE" | "EXTERNAL_LINKS"`, `format: "JSON_ARRAY" | "CSV" | "ARROW_STREAM"` and `row_limit?: number`.
- [ ] **Step 4: Run** `test/sql.test.ts`, `npm run typecheck`. Expected: PASS (callers of `getStatement(id, rowLimit)` and `runStatement` in `src/metadata.ts` and tests fail typecheck until Task 6; fix only `getStatement` callers here).

### Task 6: Metadata service

**Files:**

- Modify: `src/metadata.ts`
- Test: `test/metadata.test.ts`

**Interfaces:**

- Consumes: `SqlService.runQuery`, `SqlService.getStatement` (Task 5).
- Produces:
  - `listObjects(request: { catalog?: string; schema?: string; pattern?: string; limit?: number }): Promise<{ level: "catalogs" | "schemas" | "tables"; items: Array<NamedItem | TableSummary>; truncated: boolean }>`: no arguments lists catalogs, `catalog` lists schemas, both list tables; `schema` without `catalog` throws `InvalidArgumentError`; default limit 100, maximum 500; the pattern is applied before the limit.
  - `describeTable(fullName: string, options?: { sampleRows?: number; lineage?: boolean }): Promise<TableDescription & { sample?: StatementResult; lineage?: { upstream: LineageEdge[]; downstream: LineageEdge[] } }>`: a sample that fails or lineage that throws `UnsupportedError` adds a line to `notes` instead of failing.
  - The service returns `{ listObjects, describeTable, searchMetadata }`; `listCatalogs`, `listSchemas`, `listTables`, `sampleTable` and `tableLineage` stay internal. Internal SQL uses `runQuery`.

- [ ] **Step 1: Write failing tests:** `listObjects({})` returns `level: "catalogs"`; with 3 tables and `limit: 2` it returns 2 items and `truncated: true`; `pattern: "ord*"` filters before the limit; `listObjects({ schema: "s" })` rejects `InvalidArgumentError`; `describeTable("main.s.t", { sampleRows: 2, lineage: true })` includes `sample` and `lineage`; with a failing lineage query it returns `notes` containing `Lineage is unavailable`; `searchMetadata` and tags reads call `runQuery` and surface the "did not finish" error instead of an empty list (regression for the silent empty result).
- [ ] **Step 2: Run** `test/metadata.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and update the fakes in `test/helpers.ts` (`fakeServices`): `sql.runQuery`, new metadata methods.
- [ ] **Step 4: Run** `test/metadata.test.ts`, `npm run typecheck`. Expected: PASS.

### Task 7: Export types and paths

**Files:**

- Create: `src/export/types.ts`, `src/export/paths.ts`
- Modify: `src/sql.ts` (import `ExportFormat` instead of the local alias)
- Test: `test/export-paths.test.ts`

**Interfaces:**

- Produces in `types.ts`:
  - `type ExportFormat = "csv" | "parquet" | "sqlite"`
  - `type ExportStatus = "PENDING" | "DOWNLOADING" | "SUCCEEDED" | "FAILED" | "CANCELED"`
  - `interface ManifestColumn { name: string; type_name: string; type_text: string; type_precision?: number; type_scale?: number; position: number }`
  - `interface ExportProgress { chunksDone: number; chunksTotal: number; rows: number; bytes: number }`
  - `interface ExportState { id: string; statementId: string; format: ExportFormat; path: string; status: ExportStatus; progress?: ExportProgress; files?: string[]; rows?: number; bytes?: number; truncated?: boolean; error?: string }`
  - `interface ChunkSink { write(chunk: { index: number; rowCount: number; bytes: Uint8Array }): Promise<void>; finish(): Promise<{ files: string[] }>; abort(): Promise<void> }`; `write` is called sequentially in chunk order.
  - `interface SinkContext { id: string; dir: string; columns: ManifestColumn[] }`
- Produces in `paths.ts`: `sanitizeExportName(name: string | undefined): string` (characters outside `[A-Za-z0-9._-]` become `_`, a leading dot is removed, cut at 64, empty gives `export`); `exportId(name: string | undefined, statementId: string): string` (`<sanitized>-<first 8 characters of statementId>`); `exportPath(dir: string, id: string, format: ExportFormat): string` (`<dir>/<id>.csv`, `<dir>/<id>.db`, `<dir>/<id>`).

- [ ] **Step 1: Write failing tests:** `sanitizeExportName("../../etc/x")` equals `"_.._etc_x"` (invalid characters become `_`, then leading dots are removed) and `sanitizeExportName("..\\x")` contains no `\` or `/`; `sanitizeExportName("")` and `undefined` give `"export"`; a 100-character name is cut to 64; `exportId("sales", "01f0abcd-9999")` equals `"sales-01f0abcd"`; `exportPath` returns the three shapes with `join`.
- [ ] **Step 2: Run** `test/export-paths.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.

### Task 8: CSV sink

**Files:**

- Create: `src/export/csv-sink.ts`
- Test: `test/export-csv.test.ts`

**Interfaces:**

- Consumes: `ChunkSink`, `SinkContext`, `exportPath` (Task 7).
- Produces: `createCsvSink(context: SinkContext): Promise<ChunkSink>`.

- [ ] **Step 1: Write failing tests** (temporary directory per test): two chunks `"id,s\n1,a\n"` and `"2,\"b,\nc\"\n"` written give `<id>.csv` equal to their concatenation; no `.csv` exists before `finish()` and `<id>.csv.part` exists during writing; `abort()` leaves neither; with no chunks, `finish()` writes only the header line built from `columns` (`id,s\n` for columns `id` and `s`, names containing a comma or quote are CSV-quoted); `finish()` returns `{ files: [<id>.csv path] }`.
- [ ] **Step 2: Run** `test/export-csv.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `fs/promises` file handle appending to `.part` and renaming in `finish()`.
- [ ] **Step 4: Run** the test. Expected: PASS.

### Task 9: SQLite sink

**Files:**

- Create: `src/export/sqlite-sink.ts`
- Test: `test/export-sqlite.test.ts`

**Interfaces:**

- Consumes: `ChunkSink`, `SinkContext`, `ManifestColumn`, `exportPath`.
- Produces: `createSqliteSink(context: SinkContext): Promise<ChunkSink>` and `sqliteColumnType(column: ManifestColumn): "INTEGER" | "REAL" | "TEXT"`.
- Mapping (spec section 5.3): `BYTE`, `SHORT`, `INT`, `LONG`, `BOOLEAN` give `INTEGER`; `FLOAT`, `DOUBLE` give `REAL`; `DECIMAL` gives `REAL` when `type_precision <= 15`, otherwise `TEXT`; everything else gives `TEXT`. `BOOLEAN` values `"true"`/`"false"` are bound as 1/0; all other values are bound as the received text or `NULL`.

- [ ] **Step 1: Write failing tests:**
  - `sqliteColumnType` for each row of the mapping, including `DECIMAL` precision 15 versus 16.
  - Chunk bytes `JSON.stringify([["9223372036854775807","1.50","true","x"],[null,null,"false","y"]])` for columns `LONG`, `DECIMAL(10)`, `BOOLEAN`, `STRING` produce, in `<id>.db` table `result`: `typeof` integer and exact `9223372036854775807` (read with `setReadBigInts(true)`), `1.5` real, `1` and `0`, and `NULL`s preserved.
  - A `DECIMAL` of precision 20 keeps the text `"12345678901234567.89"`.
  - **Hostile names:** columns named `a"b`, `with space` and `select` all work (identifiers are double-quoted with `"` doubled).
  - Two chunks insert in the order written; the `.db` exists only after `finish()`; `abort()` leaves no file; zero chunks gives an existing, empty `result` table.
- [ ] **Step 2: Run** `test/export-sqlite.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:sqlite` `DatabaseSync` on `<id>.db.part`: create the table from `columns`, one prepared `INSERT`, one `BEGIN`/`COMMIT` per chunk, rename in `finish()`. No PRAGMAs (ADR 0003).
- [ ] **Step 4: Run** the test. Expected: PASS.

### Task 10: Parquet sink

**Files:**

- Create: `src/export/parquet-sink.ts`
- Modify: `package.json`, `package-lock.json` (dependency)
- Test: `test/export-parquet.test.ts`

**Interfaces:**

- Consumes: `ChunkSink`, `SinkContext`, `exportPath`.
- Produces: `createParquetSink(context: SinkContext): Promise<ChunkSink>`; writes `part-00000.parquet`, `part-00001.parquet`... (index padded to 5 digits) inside `<id>.part/` and renames the directory to `<id>` in `finish()`.

- [ ] **Step 1: Install** `npm install --save-exact parquet-wasm@0.9.0`. Expected: `package.json` lists `"parquet-wasm": "0.9.0"`.
- [ ] **Step 2: Write failing tests** using `test/fixtures/sample.arrows`: writing it as chunk 0 and chunk 1 gives two files whose first and last 4 bytes are `PAR1` and for which `readMetadata(bytes).fileMetadata().numRows()` is 3; `finish()` returns the two paths in order; the final directory does not exist before `finish()`; `abort()` leaves no directory; zero chunks gives an existing empty directory.
- [ ] **Step 3: Run** `test/export-parquet.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** with `Table.fromIPCStream(bytes)` and `writeParquet(table, new WriterPropertiesBuilder().setCompression(Compression.ZSTD).build())`, building the properties for every chunk (`writeParquet` frees them).
- [ ] **Step 5: Run** the test. Expected: PASS.

### Task 11: Export manager

**Files:**

- Create: `src/export/manager.ts`
- Test: `test/export-manager.test.ts`

**Interfaces:**

- Consumes: `SqlService.submitExport` (Task 5), `ChunkSink`/`ExportState` (Task 7), the three sink factories, `exportId`/`exportPath`, `LogService.startExecution`/`run` (Task 3), `DatabricksClient.get`.
- Produces:
  - `interface ExportManagerDependencies { client: DatabricksClient; sql: Pick<SqlService, "submitExport">; fetch: FetchLike; dir: string; logs: LogService; sleep(ms: number): Promise<void>; concurrency?: number; sinks?: Partial<Record<ExportFormat, (context: SinkContext) => Promise<ChunkSink>>> }` (default concurrency 4; `sinks` lets tests inject fakes).
  - `interface ExportManager { start(request: { statement: ExecuteSqlRequest; format: ExportFormat; name?: string }): Promise<ExportState>; get(statementId: string): Promise<ExportState | undefined>; wait(statementId: string, timeoutMs: number): Promise<ExportState | undefined>; cancel(statementId: string): Promise<boolean>; cleanup(now?: number): Promise<void>; close(): Promise<void> }`; `cleanup` deletes entries in `dir` whose name ends in `.part` and whose modification time is more than 24 hours before `now` (default `Date.now()`), and is called once when the manager is created in `cli.ts`.
  - `createExportManager(deps: ExportManagerDependencies): ExportManager`.
- Behavior: `start` creates `dir` (mode `0o700` outside Windows), rejects with `InvalidArgumentError` when `exportPath` already exists, calls `submitExport`, registers the job and returns `PENDING` at once. The job polls `GET /api/2.0/sql/statements/{id}` (sleep 1 s growing to 10 s) until `SUCCEEDED` (a `FAILED`/`CANCELED` state fails the job), reads `manifest.total_chunk_count`, `manifest.truncated` and `manifest.schema.columns`, then downloads chunks. Each chunk link is requested from `/result/chunks/{n}` (chunk 0 may use `result.external_links`) right before its download, fetched with `deps.fetch(url)` and no headers, and requested once more if the response is 403 or the link has expired. At most `concurrency` downloads run at once and a chunk may start only if its index is less than `nextToWrite + 2 * concurrency`; writes to the sink happen strictly in chunk order. Progress and `files` are filled as chunks finish. Each job runs inside `logs.run(execution, ...)` with `execution = logs.startExecution({ toolName: "export" })`: `info` "Export started" (format, statementId, path) and "Export finished" (rows, chunks, bytes, durationMs, truncated), `debug` per chunk, failure through `execution.fail(error)`.

- [ ] **Step 1: Write failing tests** with a fake client, fake `fetch`, fake sink recording calls, `sleep: async () => undefined` and `withLogs` from `test/helpers.ts`:
  - 5 chunks with the fake `fetch` resolving in reverse order are written to the sink as indexes `0..4` in order, with never more than 4 downloads in flight; `fetch` is called with a single argument (no `Authorization` header anywhere).
  - `get` shows `DOWNLOADING` with `progress.chunksDone` growing and finally `SUCCEEDED` with `rows`, `bytes` and `files`; `wait(id, 1000)` resolves with the final state.
  - A 403 on the first download of chunk 2 requests a new link and succeeds; a second 403 fails the job with an error message that names the chunk.
  - **Zero rows:** `total_chunk_count: 0` still calls `sink.finish()` and ends `SUCCEEDED` with `rows: 0`.
  - **Truncated:** `manifest.truncated: true` ends `SUCCEEDED` with `truncated: true`.
  - **Cancel mid-download:** with a download that never resolves until aborted, `cancel(id)` returns `true`, calls `sink.abort()`, the state is `CANCELED`, and `cancel("unknown")` returns `false`; `close()` aborts running jobs the same way.
  - A sink `write` that throws ends the job `FAILED` with `error` set and calls `sink.abort()`.
  - A `FAILED` statement state ends the job `FAILED` with the Databricks message.
  - Starting twice with the same statement id and name rejects `InvalidArgumentError` (path exists).
  - `cleanup(now)` removes a `.part` file and a `.part` directory older than 24 hours (set their `mtime` with `utimes`), keeps a newer one, and keeps finished exports.
  - Logs: after a successful job, `repository.searchLogs({ text: "Export finished" })` finds one entry whose metadata contains `rows`.
- [ ] **Step 2: Run** `test/export-manager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `manager.ts` with an `AbortController` per job passed as `signal` in the download `fetch` call (extend the call to `deps.fetch(url, { signal })`; adjust the first test to assert no `authorization` header in `init`).
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS.

### Task 12: MCP server

**Files:**

- Modify: `src/server.ts`, `test/helpers.ts`
- Test: `test/server.test.ts`

**Interfaces:**

- Consumes: `MetadataService` (Task 6), `SqlService` (Task 5), `ExportManager` (Task 11), `describeArguments`, `LogService.run` (Task 3).
- Produces:
  - `TOOL_NAMES = ["list_objects", "describe_table", "search_metadata", "execute_sql", "get_statement"] as const`.
  - `ServerDependencies` gains `exports: ExportManager`.
  - Input schemas: `list_objects { catalog?, schema?, pattern?, limit? }`; `describe_table { full_name, sample_rows? (1..100), lineage? }`; `search_metadata` unchanged; `execute_sql` as today plus `export?: { format: "csv" | "parquet" | "sqlite"; name?: string (max 64) }`; `get_statement { statement_id, wait_seconds? (0..30), cancel? }`.
  - `execute_sql` with `export` returns `{ statementId, state: "PENDING", export: ExportState }`; `get_statement` returns `{ statementId, export }` when the manager knows the id, `{ statementId, cancelled: true }` after `cancel`, otherwise the `StatementResult`. `cancel` calls `exports.cancel` and `sql.cancelStatement`.
  - Resource `resource://databricks/warehouses` returns `{ warehouses }`; `search_logs` is removed; reads of `resource://logs/*` open no execution (the resource helper takes a `record` flag); resource handlers may be async.
  - Each tool call opens one execution, runs inside `logs.run`, and writes one `info` entry when it ends with `{ ...describeArguments(args), durationMs, statementId?, warehouseId?, state?, rowCount?, truncated?, checkMs? }`; failures go through `execution.fail`.
  - Annotations: `get_statement` has `readOnlyHint: false, destructiveHint: false`; the others as today.

- [ ] **Step 1: Write failing tests** in `test/server.test.ts`:
  - `listTools` returns exactly the 5 names and `JSON.stringify(tools).length <= 2500`.
  - `execute_sql` with `export` calls `exports.start` (fake) with the format and name and returns the descriptor; without `export` the result is unchanged.
  - `get_statement` with `cancel: true` calls both cancel functions; with a known export id it returns the export state; with `wait_seconds` it calls `exports.wait`.
  - After one tool call there is exactly one `info` entry for that execution and its metadata has a truncated `statement` and parameters without `value`.
  - Reading `resource://logs/stats` leaves `repository.recentExecutions` unchanged; reading `resource://databricks/warehouses` returns the fake warehouses; `search_logs` is no longer listed.
  - Update the existing tests that used the removed tools (`list_catalogs`, `sample_table`, `table_lineage`, `search_logs`) to the new ones.
- [ ] **Step 2: Run** `test/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep descriptions terse to meet the character budget; update `INSTRUCTIONS` to the 5 tool names and the export workflow. Extend `fakeServices` in `test/helpers.ts` with a fake `exports` manager.
- [ ] **Step 4: Run** `test/server.test.ts`, `npm run typecheck`. Expected: PASS.

### Task 13: Wiring, HTTP warning and doctor

**Files:**

- Modify: `src/cli.ts`, `src/http.ts`, `src/doctor.ts`
- Test: `test/http.test.ts`, `test/doctor.test.ts`, `test/cli.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces:
  - `HttpServerOptions.onUnauthorized?(): void`, called when a request is rejected with `401`.
  - `DoctorDependencies` gains `fetch: FetchLike` and `ensureExportDir(dir: string): Promise<void>`; two new checks, `Export directory` (writable) and `Result download` (a `SELECT 1` submitted with `EXTERNAL_LINKS` and `CSV`, whose first link is downloaded with no `Authorization` header and answers 200); `fail` for the directory, `warn` with a `next` about proxies for the download.
  - In `cli.ts`: the client receives `onRetry` (`logs.current().warn("Databricks request retried", event)`) and `onRequest` (`debug`); auth dependencies get `onRefresh` (`debug`); `createSqlService` receives `maxExportBytes: settings.exportMaxBytes` and `onWarehouseChosen` (`info`); `createExportManager({ client, sql, fetch, dir: settings.exportDir, logs, sleep })` is created inside the lazy `services` and exposed through `lazy<ExportManager>`; `onUnauthorized` uses `createRateLimitedLogger` with 60 000 ms and warns `HTTP request rejected with 401` plus the suppressed count; shutdown calls `exports.close()` only if the services were created; `ENVIRONMENT_HELP` lists `DAK_EXPORT_DIR` and `DAK_EXPORT_MAX_BYTES`.

- [ ] **Step 1: Write failing tests:** HTTP: a request without the bearer token calls `onUnauthorized` once and still answers 401 without echoing the token; doctor: with healthy fakes the report contains `[ok]` for both new checks; a failing `ensureExportDir` gives `[fail] Export directory` with a `next`; a download that answers 403 gives `[warn] Result download`; with failed authentication both new checks are `skip`.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** the three files, `npm run typecheck` and `npm run build`. Expected: PASS and a clean build.

### Task 14: End-to-end and integration tests

**Files:**

- Modify: `test/e2e.test.ts`, `test/integration/workspace.it.ts`

**Interfaces:**

- Consumes: the whole server through `dak mcp` over stdio and HTTP.

- [ ] **Step 1: Extend the e2e Databricks stub** with a statement `SELECT * FROM big` that answers `SUCCEEDED` with `manifest.total_chunk_count: 2`, columns `id` and `s`, and `external_links` that point to a second local HTTP server (the presigned origin). That server serves `id,s\n1,a\n` and `2,b\n` and records the `authorization` header of every request. `GET .../result/chunks/1` returns the second link.
- [ ] **Step 2: Write failing e2e tests:** `execute_sql` with `export: { format: "csv", name: "big" }` returns `state: "PENDING"`; polling `get_statement` with `wait_seconds` reaches `SUCCEEDED`; the file `<DAK_EXPORT_DIR>/big-<8 chars>.csv` equals `id,s\n1,a\n2,b\n`; the presigned origin never saw an `authorization` header; `listTools` has 5 tools; reading `resource://logs/stats` does not change the execution count; an export with `cancel: true` while the stub delays chunk 1 leaves no `.part` file.
- [ ] **Step 3: Add integration cases** (opt-in, `DAK_IT_PROFILE`): `TABLE <table>`, `VALUES (1)`, `FROM <table> SELECT *`, a `WITH ... SELECT` and `(SELECT 1)` all pass the read-only check (if one does not, report it; do not widen the accepted prefixes without the user); `/* /* */ SHOW */ DROP TABLE IF EXISTS main.default.dak_it_never_exists` and `SHOW CATALOGS; DROP TABLE IF EXISTS main.default.dak_it_never_exists` are rejected by `dak` or by Databricks and nothing is created or dropped (if Databricks executes the second statement, stop and report: ADR 0008 assumes the API rejects several statements); a CSV export of `range(600000)` has exactly one header line and 600001 lines; a Parquet export of a table with `NULL`, `DATE`, `BINARY` and `MAP` columns completes and every file starts and ends with `PAR1`; a SQLite export opens with `node:sqlite` and `count(*)` matches the manifest row count; cancelling an export of `range(100000000)` leaves no `.part`.
- [ ] **Step 4: Run** `npm test` (expected: PASS) and, with `DAK_IT_PROFILE=syntonize npm run test:integration`, report each integration result (the profile is the user's choice; confirm before running).

### Task 15: Documentation and final verification

**Files:**

- Modify: `README.md`, `docs/design.md`, `superpowers/spec/2026-10-19-export-and-tools-design.md`

- [ ] **Step 1: Update `README.md`:** the tools table (5 tools), the tiebreak note tool names, a new "Exporting results" section (formats, `DAK_EXPORT_DIR`, `DAK_EXPORT_MAX_BYTES`, the CSV `null` caveat, SQLite type mapping, exports lost on restart), the read-only description (Task 4 behavior), the configuration table and the logging section (levels, no parameter values, `resource://logs/*` not recorded).
- [ ] **Step 2: Align the design documents** with what was built: in `docs/design.md` and the spec, state that the Parquet export writes into `<id>.part/` and renames the directory to `<id>`, and that `get_statement` accepts `wait_seconds` up to 30.
- [ ] **Step 3: Lint the Markdown** with the same commands as before (`npx markdownlint-cli2` and `npx prettier --check`) on every changed `.md`. Expected: 0 issues.
- [ ] **Step 4: Verify the spec criteria:** `npm run typecheck`, `npm run build`, `npm test` all pass; the character budget test passes; `grep -rn "search_logs\|list_catalogs\|sample_table\|table_lineage\|cancel_statement" src README.md` finds nothing outside historical ADR text.
- [ ] **Step 5: Report** a summary of results and the list of files changed, so the user can structure the branches and commits.
