# databricks-agent-kit - Implementation Plan

Design: [design.md](design.md). Method: TDD (red -> green -> refactor) with `node:test`; every phase starts by writing the failing tests listed for it. Branch `feature/mcp-server`, one Conventional Commit per phase.

## Phase 0 - Bootstrap

- `package.json` (ESM, `bin: dak`, scripts `build`, `test`, `typecheck`), `tsconfig.json` (strict, `NodeNext`), `.gitignore` (`node_modules`, `dist`, `.storage`).
- Done when: `npm run build` and `npm test` pass with a smoke test.

## Phase 1 - Configuration and authentication

Tests first:

- `.databrickscfg` parsing: sections, `DEFAULT`, comments, missing file, missing profile.
- Resolution order: env PAT > env M2M > profile `token` > profile M2M > profile `databricks-cli` > explicit error.
- Host normalization (scheme, trailing slash).
- M2M: token request shape, in-memory cache, refresh before expiry.
- U2M: parses `databricks auth token` JSON; CLI missing or not logged in -> actionable error.
- Options: flags override env; `DAK_MAX_ROWS`, `DAK_ALLOW_WRITES`, HTTP and storage settings.

## Phase 2 - REST client and error mapping

Tests first:

- Bearer header, JSON body, query string.
- Retries on 429/503 with backoff (bounded); no retry on 4xx.
- Error mapping: `PERMISSION_DENIED`, `NOT_FOUND`, `FEATURE_DISABLED`, `UNAUTHENTICATED`, `RESOURCE_EXHAUSTED`, non-JSON bodies; original code kept.
- Secrets never appear in error messages.

## Phase 3 - SQL execution

Tests first:

- Guard: allowed keywords, comments and strings stripped, multiple statements rejected, `WITH ... INSERT` rejected, writes allowed with the flag.
- Request shape: warehouse, catalog/schema, named parameters, `row_limit`, `wait_timeout=30s`, `on_wait_timeout=CONTINUE`.
- Result shaping: columns + rows, `truncated`, byte cap, hard row cap.
- Pending/running -> `statement_id`; `get_statement`, `cancel_statement`; `FAILED` -> mapped error with SQLSTATE.
- Warehouse selection: explicit > configured > running > serverless > first; none -> actionable error.

## Phase 4 - Metadata

Tests first:

- Catalogs, schemas, tables with pagination (`next_page_token`) and `name_pattern`.
- `describe_table`: columns, comments, PK/FK, clustering/partitioning; tags from information_schema.
- `search_metadata`: parameterized SQL over information_schema, limit.
- `sample_table`: identifier quoting (backticks, hyphens), bounded limit.
- `table_lineage`: query on `system.access.table_lineage`; missing schema -> explicit "unsupported" message.

## Phase 5 - Logging subsystem

Tests first:

- UUID v7: format, version/variant bits, time ordering.
- Schema creation, PRAGMAs (WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, `busy_timeout`), indexes.
- Queue: FIFO order, flush at 100 events, flush after 5 s, one transaction per flush, flush on close.
- Executions: start -> completed / failed (stack trace) / cancelled; lifecycle execution.
- Level threshold (`DAK_LOG_LEVEL`); secrets redacted from metadata.
- Queries: recent errors, recent executions, execution detail, stats last 24 h, `search_logs` filters and total.
- Purge: 90-day cut-off, cascade, runs at start and every 24 h (timer does not keep the process alive).
- Nothing written to stdout.

## Phase 6 - MCP server

Tests first (in-memory MCP client/server pair):

- Tool list and schemas; server `instructions` present.
- Each tool delegates and returns structured text; errors return `isError` with the mapped message.
- Resources: the four URIs and the execution template.
- Every tool call and resource read is recorded as an execution.
- HTTP: Host validation, bearer token required off-loopback, `401` without token.

## Phase 7 - Doctor

Tests first:

- Reports profile, host, auth method, identity (`current-user/me`), warehouse availability, SQL `SELECT 1`, information_schema and lineage availability, storage path; each check `ok` / `warn` / `fail` with a next step.

## Phase 8 - End to end and documentation

- End-to-end test: local stub of the Databricks REST API; spawn `dak mcp` over stdio and start it over HTTP; MCP client lists tools/resources, runs `execute_sql`, `describe_table`, an error path, and reads the execution from `resource://logs/execution/{id}`.
- README: purpose, installation, authentication methods and manual actions, agent registration (stdio/HTTP), skills coexistence and the `AGENTS.md` tiebreak text, logging, troubleshooting.
- Integration tests gated by `DAK_IT_PROFILE`, run once the user creates a Databricks CLI profile.
