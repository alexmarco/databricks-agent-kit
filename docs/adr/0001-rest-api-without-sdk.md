# ADR 0001: Access Databricks through the REST API only

- Status: Accepted
- Date: 2026-10-19

## Context

The official Databricks libraries for Node.js were evaluated: the SDK `@databricks/sdk-experimental` and the SQL driver `@databricks/sql`.

| Library                        | Version | Installation           | Notes                                                                                                    |
| ------------------------------ | ------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `@databricks/sdk-experimental` | 0.18.0  | 21 MB and 27 packages  | Its README says "PREVIEW - NOT FOR PRODUCTION USE" and warns about breaking changes                      |
| `@databricks/sql`              | 2.2.0   | 52 MB and 100 packages | Uses Thrift, sends telemetry by default, and its OAuth U2M does not reuse the Databricks CLI token cache |

## Decision

Access stays on `fetch` against the public REST API: Statement Execution, Unity Catalog and SQL Warehouses. No Databricks library is added.

## Rejected alternatives

- Adopt the SDK: it adds weight and the risk of breaking changes for six endpoints.
- Adopt the SQL driver: it gives nothing that `EXTERNAL_LINKS` does not (parallel download and Arrow) and it changes the channel.

## Consequences

- The low-resource and few-dependencies constraints are kept.
- We must maintain our own client (retries, pagination, errors).
- Reconsider when the SDK reaches version 1.0 or when Azure CLI, Azure managed identity or GCP authentication is needed.
