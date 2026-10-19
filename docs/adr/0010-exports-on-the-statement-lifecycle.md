# ADR 0010: Exports on the statement lifecycle module

- Status: Accepted
- Date: 2026-10-19

## Context

ADR 0009 created the statement lifecycle module and left the export manager with its own statement requests: it built the statements path, polled the export statement with its own schedule, cancelled the Databricks statement with its own request and asked for the link of a result chunk itself. It also received the Databricks client only for those requests. Issue #5 (spec: issue #3) moves them behind the module.

## Decision

The lifecycle interface grows by two methods, both specific to exports; `cancel` is reused as it is.

| Method                                      | Behaviour                                                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awaitExport(statementId, signal)`          | Polls an `EXTERNAL_LINKS` statement until it succeeds and returns `ExportResultInfo`: columns, chunk count, row count of each chunk, `truncated` and the link of chunk 0 when the response carries it |
| `exportChunkLink(statementId, index, signal)` | Requests a fresh presigned link for a result chunk and returns an `ExportChunkLink` (`url`, `rowCount?`, `expiration?`)                                                                |

- **The polling schedule of exports is owned by the module and differs from `get` by design.** `get` serves the agent and is bounded by the requested wait (0 to 30 s). `awaitExport` serves a background job: waits of 1 s, 2 s, 3 s... growing to 10 s, with no upper bound (design section 4.6), until Databricks ends the statement or the job is cancelled. They are two schedules with two purposes, each explicit in the module.
- **Cancellation of the wait is the caller's `AbortSignal`.** Both methods reject with the signal's reason as soon as it aborts, and `awaitExport` stops polling. The manager keeps its job `AbortController`; it does not need to wrap the calls. `untilAborted` moves to `src/abort.ts` because the module and the manager (download retry waits) both use it.
- **The module maps the API response to a clean shape.** The manager no longer sees `snake_case` Databricks fields (`external_link`, `row_count`, `total_chunk_count`...); link URLs still carry credentials and are never logged or returned (AGENTS.md, ADR 0007).
- **Errors are unchanged.** A statement that ends `FAILED` gives a `SqlError` with the Databricks message alone; `CANCELED` or `CLOSED` gives `Export statement ended in state <state>.`; a missing chunk link gives `Export: Databricks returned no link for chunk <n>.`. The error mapping of plain statements (`[ERROR_CLASS] message (SQLSTATE ...)`) is not applied to exports, so the messages the agent reads in an export state stay as they were.
- **The export manager depends on `Pick<StatementLifecycle, "submitExport" | "awaitExport" | "exportChunkLink" | "cancel">`** under the key `statements` and no longer receives the `DatabricksClient`. It keeps the job map, presigned chunk downloads (plain `fetch` without `Authorization`) with retries and link renewal, ordered writing to the sinks, progress and cancellation of the local job. Its best-effort statement cancel is `statements.cancel(...)`, never awaited by `cancel` and never failing it.
- **Diagnostics stay an optional parameter of `submitExport`** until the execution scope module removes it (ADR 0009).

Alternatives considered:

- *A single `export(request, format, signal)` that submits, waits and yields chunks*: hides the most, but moves the job map, retries and link renewal into the module or forces it to know about downloading, and `get_statement` still needs the statement id before the export ends. Rejected: the module would stop being about statements.
- *Share the schedule of `get`*: `get` has a 30 s bound and no signal; exports need no bound and cancellation. Forcing one schedule onto both would add flags to `get`. Rejected.

## Consequences

- The statements path is built only in `src/statements.ts` (the doctor's download check still writes it until its slice moves it). A change to polling, cancellation or chunk links is made once (locality), and exports use the same cancel as `get_statement` (leverage).
- Seam: the lifecycle interface. `test/statements.test.ts` covers `awaitExport` and `exportChunkLink` against the fake client; `test/export-manager.test.ts` uses a fake of the export methods of the interface and no statement routes.
- Behaviour visible to the agent and the operator does not change. The poll waits are no longer observable through the manager's injected `sleep`, which now only paces download retries.
- Later slices: `get_statement` resolves export versus plain statement behind one interface, and the doctor's download check uses `submitExport`, `awaitExport` and `exportChunkLink`.
