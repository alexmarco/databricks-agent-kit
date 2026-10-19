# Architecture decision records

Every relevant technical decision has an ADR (Architecture Decision Record) in this directory. An ADR is not rewritten when a decision changes: a new one is created to replace it and the old one becomes "Superseded".

Possible statuses: Proposed, Accepted, Superseded.

| ADR                                        | Decision                                      | Status   |
| ------------------------------------------ | --------------------------------------------- | -------- |
| [0001](0001-rest-api-without-sdk.md)       | Access Databricks through the REST API only   | Accepted |
| [0002](0002-columnar-output-format.md)     | Columnar JSON output for queries              | Accepted |
| [0003](0003-export-with-external-links.md) | Export large results with `EXTERNAL_LINKS`    | Accepted |
| [0004](0004-parquet-with-parquet-wasm.md)  | Parquet with `parquet-wasm` from Arrow chunks | Accepted |
| [0005](0005-do-not-adopt-adbc.md)          | Do not adopt ADBC or Arrow Flight SQL for now | Accepted |
| [0006](0006-minimal-mcp-surface.md)        | Minimal MCP surface of 5 tools                | Accepted |
| [0007](0007-logging-policy.md)             | Logging policy                                | Accepted |
| [0008](0008-simplified-read-only-check.md) | Simplified read-only check                    | Accepted |

Current design: [docs/design.md](../design.md).
