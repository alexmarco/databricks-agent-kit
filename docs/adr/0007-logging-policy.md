# ADR 0007: Logging policy

- Status: Accepted
- Date: 2026-10-19

## Context

The code review found that:

- Expected errors (read-only mode, invalid argument, permission denied) are stored as `error` with a stack trace, which pollutes recent errors and statistics.
- Every call writes two entries ("started" and "completed") that duplicate the `executions` table.
- Reading the logs opens executions and counts them as activity.
- Parameters are stored with their value, and they may be personal data.
- Calls to Databricks leave no trace: retries, chosen warehouse, token refresh, duration of the read-only check and `401` rejections.

## Decision

- `DakError`s are stored as `warn` without a stack trace; only unexpected errors are `error` with a stack trace.
- One entry per call, when it ends, with tool, arguments, duration and a summary of the result (`statementId`, `warehouseId`, state, rows, `truncated`).
- Of the SQL, the first 4 KB are stored; of the parameters, name and type, not the value.
- Reading `resource://logs/*` does not open executions.
- The following are logged: retries (`warn`), the warehouse choice (`info`), token refresh and every HTTP request (`debug`), the start and end of each export (`info`) and HTTP `401` rejections (`warn`, limited to one per minute).

Details in [section 7 of the export design](../../superpowers/spec/2026-10-19-export-and-tools-design.md).

## Consequences

- Recent errors and statistics reflect real failures.
- The volume of logs drops for normal calls and grows only at the `debug` level.
- The value of a parameter cannot be reconstructed from the logs; the SQL remains the main data for analysis.
- The test that expects a stack trace on a SQL failure (`test/server.test.ts`) must change.
