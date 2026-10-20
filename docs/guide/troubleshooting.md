# Troubleshooting

Start with `dak doctor --profile <name>`. It runs the checks in order and prints the next step for each failure. The
table below lists the messages you are most likely to see.

## Authentication and access

| Symptom | Fix |
| --- | --- |
| `No Databricks credentials found` | Follow one of the [authentication](/guide/authentication) options, then run `dak doctor` |
| `Could not get an OAuth token from the Databricks CLI` | `databricks auth login --profile <name>` |
| `Databricks CLI not found on PATH` | Install the CLI, or use a personal access token |
| `[PERMISSION_DENIED] ...` | Ask an admin for the privilege named in the message. See [privileges](/guide/authentication#privileges-by-capability) |
| `No SQL warehouse is accessible` | Set `DATABRICKS_WAREHOUSE_ID`, or get `CAN USE` on a warehouse |
| `Lineage is unavailable` | Lineage system tables are not enabled, or not readable, in this workspace |

## Statements

| Symptom | Fix |
| --- | --- |
| `Read-only mode: ...` | Expected. Restart with `--allow-writes` only if writes are intended. If the statement starts with a comment, remove it. Pass literals that contain `;` as `:name` parameters. See [read-only mode](/guide/read-only) |
| `Read-only check did not finish ...` or `Statement did not finish in time ...` | The warehouse is starting. Retry in a moment |
| Statement still `RUNNING` | The warehouse is starting. Call `get_statement` with `wait_seconds` |

## Exports

| Symptom | Fix |
| --- | --- |
| `Export <path> already exists; choose another name.` | Choose another `name`, or delete the old export. The new statement was cancelled |
| Export `FAILED`: `chunk N download failed (...)` | The result links could not be downloaded. Run `dak doctor` and check **Result download**. Allow the cloud-storage host in the proxy or firewall |
| Export `FAILED`: `Parquet export: chunk N could not be converted ...` | The chunk could not be converted. Export as `csv` or `sqlite` instead |
| Export `FAILED`: `SQLite export: the result has N columns ...` | SQLite allows 2000 columns. Select fewer columns, or export as `csv` or `parquet` |
| Export `SUCCEEDED` with `truncated: true` | The result exceeded `DAK_EXPORT_MAX_BYTES`. Raise it, or filter the query |
| Export `FAILED` with a file system error (`EACCES`, `ENOSPC`) | Point `DAK_EXPORT_DIR` to a writable directory with free space. `dak doctor` checks it |
| An export vanished after a restart | Exports are not resumed. Run the statement again |

## Where to look next

- The [operational logs](/guide/logs) hold the failed calls with their error entries. Read
  `resource://logs/errors/recent` from your agent, or open `logs.db` in the state directory.
- The [configuration](/guide/configuration) page lists every setting and its default.
- If the problem is not listed, open an issue in the [repository](https://github.com/alexmarco/databricks-agent-kit/issues).
