# ADR 0003: Export large results with `EXTERNAL_LINKS`

- Status: Accepted
- Date: 2026-10-19

## Context

With `INLINE`, Databricks aborts a query whose result exceeds 25 MiB. With `EXTERNAL_LINKS` the result is stored temporarily in cloud storage, split into chunks decided by the server, up to 100 GiB. Each chunk has a presigned URL that expires after 15 minutes at most and is downloaded without the `Authorization` header.

It was verified against a real workspace, with results of 600,000 and 3,000,000 rows, that:

- `CSV` chunks are split on row boundaries, only the first has a header, and all of them end with a newline. Concatenated in order they form a valid CSV.
- `ARROW_STREAM` chunks are complete Arrow IPC streams, with their schema and without LZ4 compression.
- `JSON_ARRAY` chunks are an array of arrays of text; `STRUCT` and `ARRAY` arrive as JSON text.
- In CSV, SQL `NULL` is written as the text `null`.

## Decision

`execute_sql` accepts `export: { format, name? }` with `csv`, `parquet` or `sqlite`. The export runs in the background and is followed with `get_statement`. Files are written only under `DAK_EXPORT_DIR`; the agent never chooses paths. The export size is capped by `DAK_EXPORT_MAX_BYTES` (default 10 GiB), sent as `byte_limit`.

- CSV: a single file, with the chunks concatenated in order.
- Parquet: one file per chunk ([ADR 0004](0004-parquet-with-parquet-wasm.md)).
- SQLite: a single file, loaded from `JSON_ARRAY` with `node:sqlite`. Values are bound as text and the column affinity converts them. `BOOLEAN` is converted to 0 or 1, `DECIMAL` of up to 15 digits goes to `REAL` and the rest to `TEXT`.

## Rejected alternatives

- Partition by column: the API does not offer it; it would require reading the rows, or having Databricks write to a Volume, which is a write.
- Tune SQLite with PRAGMAs or multi-row inserts: measured with a real chunk, all variants stay between 909,000 and 1,039,000 rows per second. The dominant cost is `JSON.parse`.
- Bind `DECIMAL` as `NUMERIC`: it loses precision (`12345678901234567.89` became `12345678901234568`).

## Consequences

- Exports live in the process: if it restarts, they must be requested again.
- A `NULL` in CSV cannot be told apart from the string `"null"`; it is documented.
- Presigned URLs point to cloud storage and a proxy can block them; `dak doctor` checks it.
