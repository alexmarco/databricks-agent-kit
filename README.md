# databricks-agent-kit

MCP server (`dak`) that gives coding agents governed access to Databricks: run SQL on a SQL warehouse and inspect Unity
Catalog metadata, over **stdio** or **Streamable HTTP**, with persistent operational logs in SQLite.

- Talks only to public workspace REST APIs (SQL Statement Execution, Unity Catalog, SQL Warehouses); exports also
  download result chunks from the presigned cloud-storage links that Databricks returns.
- No Databricks-served models, no AI Gateway / Unity Gateway, no Databricks-managed MCP servers, no Genie: your agent
  keeps its own model subscription.
- Read-only by default; the real security boundary is the Unity Catalog permissions of the identity you configure.
- Features the workspace does not offer (edition, admin settings, permissions) fail with an explicit message;
  `dak doctor` reports them up front.

Design: [docs/design.md](docs/design.md).

## Requirements

- Node.js 22.13 or later (developed on Node.js 24). The log store uses the built-in `node:sqlite` module.
- A Databricks workspace with Unity Catalog and at least one SQL warehouse you can use.
- Databricks CLI 1.0.0 or later only if you authenticate with OAuth U2M (recommended for personal use) or install the
  official Databricks skills.

## Installation

```bash
git clone <this-repository> databricks-agent-kit
cd databricks-agent-kit
npm ci
npm run build
npm link            # optional: puts `dak` on your PATH
dak --version
```

Without `npm link`, run the server as `node <absolute-path>/dist/cli.js`. On Windows, some MCP clients cannot launch
`.cmd` shims such as the one `npm link` creates; use `node` plus the absolute path to `dist/cli.js` in those clients.

## Authentication

`dak` resolves credentials in this order:

1. **Explicit profile** (`--profile <name>`): only that profile from `~/.databrickscfg` is used; environment credentials
   are ignored.
2. **Environment variables**: `DATABRICKS_HOST` plus either `DATABRICKS_TOKEN` (personal access token) or
   `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` (OAuth M2M).
3. **Profile** named by `DATABRICKS_CONFIG_PROFILE`, else `DEFAULT`, from `~/.databrickscfg` (or the file in
   `DATABRICKS_CONFIG_FILE`).

Within a profile, the method is chosen by its keys: `token` -> personal access token; `client_id` + `client_secret` ->
OAuth M2M; `auth_type = databricks-cli` -> OAuth U2M through the Databricks CLI. Any other `auth_type` (for example
`azure-cli`) is rejected with a message listing the supported methods.

Tokens are kept in memory only, refreshed before they expire, and never written to logs or tool output. The workspace
host must use `https` (plain `http` is accepted only for loopback test stubs), and tokens are only sent to that host.

### Option A - OAuth U2M through the Databricks CLI (recommended for personal use)

Manual steps:

1. Install or upgrade the Databricks CLI to 1.0.0 or later:
   - Windows: `winget install Databricks.DatabricksCLI` (or `winget upgrade Databricks.DatabricksCLI`).
   - macOS/Linux: see the [CLI installation guide](https://docs.databricks.com/aws/en/dev-tools/cli/install).
2. Log in once per workspace. This opens the browser and writes a profile with `auth_type = databricks-cli` to
   `~/.databrickscfg`:

   ```bash
   databricks auth login --host https://<workspace-host> --profile dev
   ```

3. Optional: pin a SQL warehouse by adding `warehouse_id = <id>` to the `[dev]` section of `~/.databrickscfg`.
4. Start the server with `--profile dev` (or set `DATABRICKS_CONFIG_PROFILE=dev`).

`dak` asks the CLI for a fresh token (`databricks auth token --profile dev`) when needed; the CLI owns the login, the
token cache (`~/.databricks/token-cache.json`) and refresh. When the refresh token expires, tool calls return an error
asking you to run `databricks auth login --profile dev` again; no server restart is needed.

### Option B - Personal access token

Manual steps:

1. In the workspace, open your user menu > **Settings** > **Developer** > **Access tokens** > **Manage** > **Generate
   new token**. Set a lifetime and copy the token. Workspace admins can disable personal access tokens; if the option is
   missing, use option A or C.
2. Provide it either through the environment:

   ```bash
   export DATABRICKS_HOST=https://<workspace-host>
   export DATABRICKS_TOKEN=<token>
   ```

   or through a profile in `~/.databrickscfg`:

   ```ini
   [pat]
   host  = https://<workspace-host>
   token = <token>
   ```

3. Rotate the token before it expires. Keep `~/.databrickscfg` readable only by your user and never commit tokens.

### Option C - OAuth M2M with a service principal (unattended or shared HTTP servers)

Manual steps (some require a workspace or account admin):

1. Create a service principal and give it workspace access.
2. Generate an OAuth secret for it (admin settings > **Identity and access** > **Service principals** > the principal >
   **Secrets**). Copy the client ID and secret.
3. Grant it the permissions listed below, ideally read-only.
4. Provide the credentials through `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`, or a
   profile with `host`, `client_id` and `client_secret`.

`dak` exchanges them at `https://<workspace-host>/oidc/v1/token` (`client_credentials`, scope `all-apis`) and refreshes
the token automatically.

### Permissions to grant

| Capability                                  | Required                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Any SQL tool                                | `CAN USE` on a SQL warehouse                                                               |
| Read data                                   | `USE CATALOG`, `USE SCHEMA` and `SELECT` on the objects                                    |
| `search_metadata`, tags in `describe_table` | Read access to `system.information_schema` (it only shows objects the identity can access) |
| `describe_table` with `lineage`             | Unity Catalog system tables (`system.access`) enabled by an admin, plus `SELECT` on them   |
| Exports (`export` of `execute_sql`)         | Nothing beyond the privileges to read the data (see below for the local requirements)      |
| Writes (`--allow-writes`)                   | `MODIFY` and the DDL privileges you intend to allow                                        |

Exports need no extra Databricks privilege, but the workspace must allow `EXTERNAL_LINKS` results, this machine must
reach the cloud-storage hosts of the result links, and the server needs a writable export directory (see
[Exporting results](#exporting-results)). `dak doctor` checks all three.

**The permissions of this identity are the security boundary.** Neither the Statement Execution API nor the MCP protocol
offer a read-only mode (MCP tool annotations are only hints for the client), and the `dak` read-only check only decides
whether a statement reads; it does not stop what a read can reach. Give agents a dedicated identity (a service
principal, or a user or group used only for agents) with just what they need:

- `CAN USE` on one SQL warehouse, and `USE CATALOG`, `USE SCHEMA` and `SELECT` on the data they may read.
- No `MODIFY`, `CREATE` or ownership on data objects, no `READ` on secret scopes and no `USE CONNECTION`: SQL functions
  such as `secret()` or `http_request()` could otherwise expose secrets or reach external services.
- Everything the identity can read can reach the agent's context, and through it any tool the agent has (shell, web).
  Table comments and data are untrusted input for the agent (prompt injection).

### Verify

```bash
dak doctor --profile dev
```

It checks authentication, identity, warehouse, `SELECT 1`, `information_schema`, lineage system tables, result download,
export directory, log storage, the Databricks CLI version and the write mode, and prints the next step for anything that
fails. Exit code 1 means at least one required check failed.

- **Result download** submits `SELECT 1` as a CSV export and downloads its first chunk from the presigned link without
  credentials, exactly as an export does. It waits up to 60 s for a stopped warehouse to start. It only warns (it never
  fails) when the workspace gives no external link or when the cloud-storage host cannot be reached, because a proxy or
  firewall that allows the workspace host can still block that host; only the host name is printed.
- **Export directory** creates `DAK_EXPORT_DIR` if needed and writes and deletes a temporary file in it. It fails when
  the directory is not writable.

## Register the server in your agent

Examples use a profile named `dev`. Replace `dak` with `node <absolute-path>/dist/cli.js` if you did not run `npm link`.

### stdio (one process per agent session)

- **Claude Code**

  ```bash
  claude mcp add --scope user databricks -- dak mcp --profile dev
  ```

- **Codex** (`~/.codex/config.toml`)

  ```toml
  [mcp_servers.databricks]
  command = "dak"
  args = ["mcp", "--profile", "dev"]
  ```

- **OpenCode** (`opencode.json`)

  ```json
  {
    "mcp": {
      "databricks": {
        "type": "local",
        "command": ["dak", "mcp", "--profile", "dev"],
        "enabled": true
      }
    }
  }
  ```

- **Cursor** (`~/.cursor/mcp.json`)

  ```json
  {
    "mcpServers": {
      "databricks": { "command": "dak", "args": ["mcp", "--profile", "dev"] }
    }
  }
  ```

### Streamable HTTP (one shared server)

```bash
dak mcp --transport http --profile dev            # http://127.0.0.1:8765/mcp
```

- Loopback only by default; requests with a foreign `Host` header are rejected (DNS rebinding protection).
- On loopback, browser requests from a non-local `Origin` are rejected.
- Binding to another address (`--host 0.0.0.0`) requires `DAK_HTTP_TOKEN` (at least 32 characters, for example
  `openssl rand -hex 32`); clients must send `Authorization: Bearer <token>`. The token can also be set on loopback.
- The server speaks plain HTTP: off loopback, put it behind a TLS-terminating reverse proxy so the token is not sent in
  clear text.
- All clients share the server's Databricks identity; client credentials are never forwarded to Databricks.
- The log resources (`resource://logs/*`) show the calls of every client, SQL text included.
- Exports are written on the machine that runs the server, in its `DAK_EXPORT_DIR`, not on the client's machine.

Clients point at the URL, for example `claude mcp add --transport http databricks http://127.0.0.1:8765/mcp` (add
`--header "Authorization: Bearer <token>"` when a token is set), or an OpenCode entry with `"type": "remote"` and
`"url": "http://127.0.0.1:8765/mcp"`.

## Tools

Five tools keep the definitions under 2,500 characters in total, so they cost little context in every session.

| Tool              | Parameters                                                                                  | Purpose                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_objects`    | `catalog?`, `schema?`, `pattern?`, `limit?`                                                 | Without arguments, catalogs; with `catalog`, its schemas; with `catalog` and `schema`, its tables. `pattern` is a substring or glob        |
| `describe_table`  | `full_name`, `sample_rows?`, `lineage?`                                                     | Columns, comments, primary/foreign keys, clustering, partitioning and tags; optional sample (max 100 rows) and upstream/downstream lineage |
| `search_metadata` | `query`, `catalog?`, `limit?`                                                               | Find tables and columns by name or comment                                                                                                 |
| `execute_sql`     | `statement`, `parameters?`, `catalog?`, `schema?`, `row_limit?`, `warehouse_id?`, `export?` | One statement with `:name` parameters and bounded results; with `export`, the full result goes to a file                                   |
| `get_statement`   | `statement_id`, `wait_seconds?`, `cancel?`                                                  | Follow up on a statement still running after 30 s or on an export (`wait_seconds` from 0 to 30), or cancel it with `cancel: true`          |

Details that the table leaves out:

- `list_objects` returns `truncated` when more objects matched than `limit` (default 100, maximum 500). `schema`
  without `catalog` is an error. `search_metadata` returns 50 matches by default (maximum 200).
- `describe_table` reports a sample or lineage that could not be read in `notes` instead of failing. Lineage comes from
  `system.access.table_lineage` (see [Permissions to grant](#permissions-to-grant)).
- `parameters` is a list of `{ name, value, type? }`; the value is sent through the API, never interpolated into the SQL.

Resource `resource://databricks/warehouses` lists the SQL warehouses visible to the identity and marks the default one.

Suggested workflow for data questions (it replaces Genie): `search_metadata` or `list_objects` -> `describe_table` (use
`sample_rows` for a quick look at the data) -> `execute_sql`. Aggregate in SQL when the result is large, or pass `export`
to write the full result to a file. The better your Unity Catalog comments, tags and keys, the better the agent's SQL.

### SQL safety and limits

- Read-only by default. Databricks itself parses each statement, so comments, string literals and dialect features
  cannot hide a write, and nothing is executed by the check:
  1. A statement with a `;` before its end (several statements, or a `;` inside a string literal) is rejected with a
     `Read-only mode` message and no call: read-only mode cannot tell those two apart. Pass a literal that contains `;`
     as a `:name` parameter instead. A single trailing `;` is fine.
  2. `SHOW`, `DESCRIBE`, `DESC` and `EXPLAIN` run directly, with no extra call, only when the keyword is the first word
     of the statement (nothing but spaces, tabs or line breaks before it) and is not followed by a `:` (a SQL-scripting
     label). Comments are deliberately not skipped: a scanner of ours that disagreed with the Databricks lexer could let
     a write through.
  3. Every other statement must pass `DESCRIBE QUERY <statement>`, which Databricks accepts only for queries (for
     example `SELECT` or `WITH`). A statement that does not parse as a query is rejected with a `Read-only mode`
     message. That includes a `SHOW`, `DESCRIBE` or `EXPLAIN` command preceded by a comment: remove the comment.

  Read commands cost no extra call to the warehouse and queries cost one. The check does not block functions such as `secret()` or `http_request()` inside a
  query: that is the job of the identity's permissions (see [Permissions to grant](#permissions-to-grant)). Enable
  writes with `--allow-writes` or `DAK_ALLOW_WRITES=true`. An `export` goes through the same check.

- Results: 100 rows by default, capped by `DAK_MAX_ROWS` (default 1000) and by size (100 KB). Both limits are applied by
  Databricks (`row_limit` and `byte_limit` of the Statement Execution API) and again by `dak`, so no `LIMIT` clause is
  needed and a large result never floods the agent's context; `truncated: true` tells the agent to aggregate, filter or
  export.
- Statements still running after 30 s return a `statement_id`; `get_statement` with `wait_seconds` (up to 30) waits for
  them.

## Exporting results

Use `export` when a result is too large for the agent's context, or when you need the data in a file for another tool.
The rows never travel through the agent: the server downloads them from Databricks and writes them to disk.

```json
{
  "statement": "SELECT * FROM main.sales.orders",
  "export": { "format": "parquet", "name": "orders" }
}
```

`export` takes a `format` (`csv`, `parquet` or `sqlite`) and an optional `name`. The name is a label: characters outside
`A-Z a-z 0-9 . _ -` become `_` and it is cut at 64 characters, so the agent cannot choose a path. The call returns at
once with the `statementId` and the export descriptor (`id`, `format`, `path`, `status`); the export runs in the
background. `row_limit` and `DAK_MAX_ROWS` do not apply to an export; the limit is `DAK_EXPORT_MAX_BYTES`.

### Where the files go

Every export is written under `DAK_EXPORT_DIR` (default `<storage dir>/exports`, see
[Configuration](#configuration)). The export identifier is `<name or "export">-<full statement id>`.
A relative `DAK_EXPORT_DIR` is resolved against the working directory of the server process, so prefer an absolute one.
Outside Windows the server creates the directory with mode `0700`; anyone who can read the directory can read the
exports. In HTTP mode the files are on the server machine.

| Format    | Result                                  | Notes                                                                                                             |
| --------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `csv`     | `<id>.csv`                              | One file, however many chunks Databricks returns; one header line                                                 |
| `parquet` | `<id>/part-00000.parquet`, `part-00001` | One ZSTD-compressed file per chunk, in a directory; `DECIMAL`, `TIMESTAMP`, `STRUCT` and `ARRAY` keep their types |
| `sqlite`  | `<id>.db`                               | One file with the table `result`                                                                                  |

Each output is written under a temporary name (`<id>.csv.part`, `<id>.db.part`, or the directory `<id>.part/` for
Parquet) and renamed when it is complete, so an unfinished export never looks finished. If the target already exists, the
export is rejected with `Export <path> already exists; choose another name.` and its statement is cancelled in
Databricks.

### Following an export

`get_statement` with the `statement_id` returns the state of the export under `export.status`:

| Status        | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `PENDING`     | The query is still running in Databricks                                                    |
| `DOWNLOADING` | Chunks are being downloaded; `progress` has `chunksDone`, `chunksTotal`, `rows` and `bytes` |
| `SUCCEEDED`   | Done: `files`, `rows`, `bytes` and `truncated`                                              |
| `FAILED`      | Failed: `error` has the reason, and no partial file is left behind                          |
| `CANCELED`    | Cancelled; the partial files were deleted                                                   |

Pass `wait_seconds` (0 to 30) to wait up to that long for the export to end before answering, instead of polling. Pass
`cancel: true` to cancel the statement in Databricks, stop the download and delete the partial files. When the result is
larger than `DAK_EXPORT_MAX_BYTES`, Databricks cuts it: the export still ends `SUCCEEDED`, with `truncated: true`.

Downloads use plain `GET` requests without an `Authorization` header, four at a time. A network error, `429` or `5xx` is
retried up to three times (after 500 ms, 1 s and 2 s); a `403` or an expired link gets one fresh link. Anything else
fails the export.

### Caveats

- **CSV `NULL`.** Databricks writes SQL `NULL` as the text `null`, and `dak` does not change the bytes it receives, so a
  `NULL` cannot be told apart from the string `"null"`. Use Parquet or SQLite when the difference matters.
- **SQLite types.** Values arrive as text and the column affinity converts them:

  | Databricks type                               | SQLite column    | Conversion                             |
  | --------------------------------------------- | ---------------- | -------------------------------------- |
  | `TINYINT`, `SMALLINT`, `INT`, `BIGINT`        | `INTEGER`        | None; `BIGINT` stays exact             |
  | `BOOLEAN`                                     | `INTEGER`        | `true` becomes 1 and `false` becomes 0 |
  | `FLOAT`, `DOUBLE`                             | `REAL`           | None                                   |
  | `DECIMAL` of 15 digits or fewer               | `REAL`           | None                                   |
  | `DECIMAL` of more than 15 digits              | `TEXT`           | None, so no precision is lost          |
  | `DATE`, `TIMESTAMP`, `STRING`                 | `TEXT`           | None                                   |
  | `STRUCT`, `ARRAY`, `MAP`                      | `TEXT` with JSON | None; query them with `json_extract`   |
  | Anything else, such as `BINARY` and intervals | `TEXT`           | None                                   |

  An empty column name becomes `column_<position>` and a repeated one (SQLite compares names without case) gets the
  first free suffix `_2`, `_3`, and so on. SQLite allows at most 2000 columns.

- **No resume, no deletion.** Exports live in the server process. If it restarts or stops, a running export is lost
  (on a clean shutdown its partial files are deleted) and `dak` does not resume it: run the statement again. `dak` never
  deletes a finished export. At startup it removes `.part` leftovers older than 24 hours from the export directory.
- **Presigned links.** The result chunks are downloaded from cloud storage, not from the workspace host. A proxy or
  firewall that allows the workspace can still block them. `dak doctor` reports it under **Result download**.

## Coexistence with the official Databricks skills

The official skills ([databricks-agent-skills](https://github.com/databricks/databricks-agent-skills)) are installed
with the Databricks CLI, not by this project. Some of them conflict with this MCP:

| Skill                                                                                                                                                             | Conflict                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `databricks-data-discovery`                                                                                                                                       | Sends every data question to Genie (`databricks genie ask`)                                                                        |
| `databricks-genie-agents`                                                                                                                                         | Genie                                                                                                                              |
| `databricks-unity-gateway`                                                                                                                                        | AI Gateway / Unity Gateway services                                                                                                |
| `databricks-core` and the skills that embed its commands (`databricks-dbsql`, `databricks-unity-catalog`, `databricks-metric-views`, `databricks-pipelines`, ...) | Tell the agent to run SQL and explore schemas with `databricks experimental aitools tools query`, `discover-schema` or `statement` |

To skip the Genie and gateway skills while keeping the useful ones (these still mention the CLI commands, so the
tiebreak note below is still needed):

```bash
databricks aitools install --skills-only --skills databricks-core,databricks-dbsql,databricks-unity-catalog,databricks-metric-views,databricks-dabs,databricks-jobs,databricks-pipelines
```

**If the official skills are installed and include any conflicting skill, add the following tiebreak note to your global
agent instructions** so the MCP takes precedence:

| Agent        | Global instructions file       |
| ------------ | ------------------------------ |
| Codex        | `~/.codex/AGENTS.md`           |
| OpenCode     | `~/.config/opencode/AGENTS.md` |
| Claude Code  | `~/.claude/CLAUDE.md`          |
| Other agents | Their global `AGENTS.md`       |

```markdown
## Databricks: MCP precedence

- For Databricks SQL execution and Unity Catalog metadata, use the `databricks` MCP server tools (`execute_sql`,
  `describe_table`, `search_metadata`, `list_objects`, `get_statement`).
- Do not use `databricks experimental aitools tools query|discover-schema|statement`, `databricks genie ask` or Genie
  for those tasks while the MCP server is available, even if a Databricks skill says so. Fall back to the CLI only when
  the MCP server is unavailable.
- The Databricks skills remain the reference for everything else (bundles, jobs, pipelines, SQL features).
```

The server also sends MCP instructions with the same precedence, but not every client applies them, so keep the note.

## Operational logs

- Stored in SQLite at `logs.db` in a per-user state directory, `%LOCALAPPDATA%\databricks-agent-kit` on Windows and
  `$XDG_STATE_HOME/databricks-agent-kit` (default `~/.local/state/databricks-agent-kit`) elsewhere; override it with
  `DAK_STORAGE_DIR`. It is shared by every `dak` process of that user and, outside Windows, readable only by its owner
  (directory `0700`, file `0600`). Logs written by earlier versions in `<install dir>/.storage` are not migrated.
- Every tool call is an execution (UUID v7) with start/end time, status (`completed`, `failed`, `cancelled`) and its
  ordered log entries; each export runs as its own execution, and server start/stop events belong to a lifecycle
  execution per process. Reading `resource://logs/*` opens no execution, so diagnosing does not inflate the statistics
  it reports; `resource://databricks/warehouses` is recorded like a tool call.
- One entry per call, written when it ends (`info`): tool name, arguments, duration and a summary of the result
  (`statementId`, `warehouseId`, state, row count, `truncated`, and `checkMs` for the read-only check). If the process
  dies first, the execution stays as `started`.
- Never logged: parameter values (only their name and type), result rows, tokens or secrets (keys such as `token`,
  `secret`, `password` and `authorization` are redacted). SQL text is logged and cut at 4096 characters.
- Levels: an expected failure (a `DakError`: read-only violation, invalid argument, `PERMISSION_DENIED`, bad SQL) is
  one `warn` entry without a stack trace; an unexpected error is one `error` entry with its stack trace. Retries of
  Databricks requests and export downloads are `warn`; the automatic warehouse choice and the start and end of an export
  are `info`; token refreshes, every Databricks request and every written export chunk are `debug`; repeated `401`
  rejections of the HTTP transport are one `warn` per minute with a counter.
- Writes go through an in-memory queue flushed every 5 s or every 100 events in one transaction, and on shutdown. Only
  events still in the queue are lost if the process crashes.
- Retention: 90 days, purged at startup and every 24 h.
- `DAK_LOG_LEVEL` (`trace`, `debug`, `info` default, `warn`, `error`, `fatal`) filters stored entries.

Diagnostics through MCP:

| Resource                                  | Content                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `resource://logs/errors/recent`           | Latest error and fatal entries                   |
| `resource://logs/executions/recent`       | Latest executions                                |
| `resource://logs/execution/{executionId}` | One execution with all its entries               |
| `resource://logs/stats`                   | Executions, errors and warnings in the last 24 h |

There is no log search tool, so the log costs no context until an agent reads one of these resources.

## Configuration

| Setting          | Flag                | Environment                                           | Default                              |
| ---------------- | ------------------- | ----------------------------------------------------- | ------------------------------------ |
| Profile          | `--profile`         | `DATABRICKS_CONFIG_PROFILE`                           | `DEFAULT`                            |
| Config file      | -                   | `DATABRICKS_CONFIG_FILE`                              | `~/.databrickscfg`                   |
| Warehouse        | -                   | `DATABRICKS_WAREHOUSE_ID` (or profile `warehouse_id`) | running, then serverless, then first |
| Allow writes     | `--allow-writes`    | `DAK_ALLOW_WRITES`                                    | `false`                              |
| Max rows         | -                   | `DAK_MAX_ROWS`                                        | `1000`                               |
| Transport        | `--transport`       | -                                                     | `stdio`                              |
| HTTP host / port | `--host` / `--port` | `DAK_HTTP_HOST` / `DAK_HTTP_PORT`                     | `127.0.0.1` / `8765`                 |
| HTTP token       | -                   | `DAK_HTTP_TOKEN`                                      | required off loopback                |
| Log storage      | -                   | `DAK_STORAGE_DIR`                                     | Per-user state directory             |
| Export directory | -                   | `DAK_EXPORT_DIR`                                      | `<log storage>/exports`              |
| Export size cap  | -                   | `DAK_EXPORT_MAX_BYTES`                                | `10737418240` (10 GiB)               |
| Log level        | -                   | `DAK_LOG_LEVEL`                                       | `info`                               |

## Troubleshooting

| Symptom                                                                        | Fix                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No Databricks credentials found`                                              | Follow one of the authentication options, then `dak doctor`                                                                                                                  |
| `Could not get an OAuth token from the Databricks CLI`                         | `databricks auth login --profile <name>`                                                                                                                                     |
| `Databricks CLI not found on PATH`                                             | Install the CLI or use a personal access token                                                                                                                               |
| `[PERMISSION_DENIED] ...`                                                      | Ask an admin for the privilege named in the message                                                                                                                          |
| `No SQL warehouse is accessible`                                               | Set `DATABRICKS_WAREHOUSE_ID` or get `CAN USE` on a warehouse                                                                                                                |
| `Read-only mode: ...`                                                          | Expected; restart with `--allow-writes` only if writes are intended. If the statement starts with a comment, remove it; pass literals that contain `;` as `:name` parameters |
| `Read-only check did not finish ...` or `Statement did not finish in time ...` | The warehouse is starting; retry in a moment                                                                                                                                 |
| `Lineage is unavailable`                                                       | Lineage system tables are not enabled or not readable in this workspace                                                                                                      |
| Statement still `RUNNING`                                                      | The warehouse is starting; call `get_statement` (use `wait_seconds`)                                                                                                         |
| `Export <path> already exists; choose another name.`                           | Choose another `name`, or delete the old export; the new statement was cancelled                                                                                             |
| Export `FAILED`: `chunk N download failed (...)`                               | The result links could not be downloaded: run `dak doctor` and check **Result download**; allow the cloud-storage host in the proxy or firewall                              |
| Export `FAILED`: `Parquet export: chunk N could not be converted ...`          | The chunk could not be converted; export as `csv` or `sqlite` instead                                                                                                        |
| Export `FAILED`: `SQLite export: the result has N columns ...`                 | SQLite allows 2000 columns; select fewer columns or export as `csv` or `parquet`                                                                                             |
| Export `SUCCEEDED` with `truncated: true`                                      | The result exceeded `DAK_EXPORT_MAX_BYTES`; raise it or filter the query                                                                                                     |
| Export `FAILED` with a file system error (`EACCES`, `ENOSPC`)                  | Point `DAK_EXPORT_DIR` to a writable directory with free space; `dak doctor` checks it                                                                                       |
| An export vanished after a restart                                             | Exports are not resumed; run the statement again                                                                                                                             |

## Development

```bash
npm test                  # unit + end-to-end (stdio and HTTP against a local Databricks API stub)
npm run typecheck
npm run build
DAK_IT_PROFILE=dev npm run test:integration   # real workspace; optional DAK_IT_TABLE (default samples.nyctaxi.trips)
```

Tests use `node:test` and run the TypeScript sources directly (Node.js type stripping). The end-to-end tests serve
presigned result links from a second local origin, so they also cover the exports.

The only runtime dependency added for exports is [`parquet-wasm`](https://github.com/kylebarron/parquet-wasm), pinned to
an exact version and imported from `parquet-wasm/node`; it converts the Arrow chunks of Databricks into Parquet files
(see [ADR 0004](docs/adr/0004-parquet-with-parquet-wasm.md)). CSV and SQLite exports use only Node.js built-ins.
Decisions are recorded in [docs/adr](docs/adr/README.md).
