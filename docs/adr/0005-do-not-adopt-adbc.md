# ADR 0005: Do not adopt ADBC or Arrow Flight SQL for now

- Status: Accepted
- Date: 2026-10-19

## Context

- No official documentation of an Arrow Flight SQL endpoint in Databricks SQL warehouses was found.
- A Databricks ADBC driver exists and is installed with `dbc install databricks`. Its publisher is the ADBC Driver Foundry (Columnar), in collaboration with Databricks; Databricks does not publish it. It is written in Go, licensed Apache-2.0, at version 0.2.0 (2026-10-09), and its documentation calls it "an early version".
- Underneath it uses `databricks-sql-go`, that is, the Thrift channel. It authenticates with PAT, OAuth U2M and OAuth M2M, and it is not documented to reuse the CLI token cache.
- The Node.js client (`@apache-arrow/adbc-driver-manager` 0.24.0, native, Node 22 or later) requires `apache-arrow` and a driver binary installed separately (13 MB on Windows; for macOS only an arm64 build exists).
- The driver was not installed or run.

## Decision

Not adopted. Access stays on the REST API ([ADR 0001](0001-rest-api-without-sdk.md)).

## Consequences

- We give up a standard Arrow client and the parallel download it already solves.
- We avoid adding three external pieces and depending on an early-version driver.
- With ADBC a query becomes a call that is awaited: `statement_id`, cancellation, the read-only check and asynchronous exports would have to be rebuilt on top.
- Reconsider if the driver becomes official, supports CLI authentication and installs without `dbc`.
