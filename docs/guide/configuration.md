# Configuration

`dak` reads its settings from command-line flags, environment variables and defaults. A flag takes precedence over the
environment variable for the same setting, and the environment variable takes precedence over the default.

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Profile | `--profile` | `DATABRICKS_CONFIG_PROFILE` | `DEFAULT` |
| Config file | - | `DATABRICKS_CONFIG_FILE` | `~/.databrickscfg` |
| Warehouse | - | `DATABRICKS_WAREHOUSE_ID` (or the profile key `warehouse_id`) | A running warehouse, then a serverless one, then the first one available |
| Allow writes | `--allow-writes` | `DAK_ALLOW_WRITES` | `false` |
| Max rows | - | `DAK_MAX_ROWS` | `1000` |
| Transport | `--transport` | - | `stdio` |
| HTTP host and port | `--host` and `--port` | `DAK_HTTP_HOST` and `DAK_HTTP_PORT` | `127.0.0.1` and `8765` |
| HTTP token | - | `DAK_HTTP_TOKEN` | Required when the host is not loopback |
| Log storage | - | `DAK_STORAGE_DIR` | The per-user state directory, see [logs](/guide/logs) |
| Export directory | - | `DAK_EXPORT_DIR` | `<log storage>/exports` |
| Export size cap | - | `DAK_EXPORT_MAX_BYTES` | `10737418240` (10 GiB) |
| Log level | - | `DAK_LOG_LEVEL` | `info` |

## Credentials

Authentication has its own resolution order and methods, described in [authentication](/guide/authentication). The
credential variables are `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`.

## Notes

- **Warehouse choice.** Without `DATABRICKS_WAREHOUSE_ID` or a profile `warehouse_id`, `dak` chooses a warehouse
  automatically and logs the choice at `info` level.
- **Writes.** `--allow-writes` and `DAK_ALLOW_WRITES` have the same effect. Writes still need matching Unity Catalog
  privileges. See [read-only mode](/guide/read-only#enabling-writes).
- **Relative paths.** A relative `DAK_EXPORT_DIR` is resolved against the working directory of the server process. Prefer an
  absolute path.
- **Log level.** `DAK_LOG_LEVEL` filters the stored log entries. The levels are `trace`, `debug`, `info`, `warn`, `error` and
  `fatal`.
- **Export directory.** `dak doctor` creates it if needed and checks that it is writable.

Run `dak doctor --profile dev` after changing any of these settings to confirm them.
