# databricks-agent-kit

MCP server (`dak`) that gives coding agents governed access to Databricks: run SQL on a SQL warehouse and inspect Unity Catalog metadata, over **stdio** or **Streamable HTTP**, with persistent operational logs in SQLite.

- Talks only to public workspace REST APIs (SQL Statement Execution, Unity Catalog, SQL Warehouses).
- No Databricks-served models, no AI Gateway / Unity Gateway, no Databricks-managed MCP servers, no Genie: your agent keeps its own model subscription.
- Read-only by default; the real security boundary is the Unity Catalog permissions of the identity you configure.
- Features the workspace does not offer (edition, admin settings, permissions) fail with an explicit message; `dak doctor` reports them up front.

Design and plan: [docs/design.md](docs/design.md), [docs/plan.md](docs/plan.md).

## Requirements

- Node.js 22.13 or later (developed on Node.js 24). The log store uses the built-in `node:sqlite` module.
- A Databricks workspace with Unity Catalog and at least one SQL warehouse you can use.
- Databricks CLI 1.0.0 or later only if you authenticate with OAuth U2M (recommended for personal use) or install the official Databricks skills.

## Installation

```bash
git clone <this-repository> databricks-agent-kit
cd databricks-agent-kit
npm ci
npm run build
npm link            # optional: puts `dak` on your PATH
dak --version
```

Without `npm link`, run the server as `node <absolute-path>/dist/cli.js`. On Windows, some MCP clients cannot launch `.cmd` shims such as the one `npm link` creates; use `node` plus the absolute path to `dist/cli.js` in those clients.

## Authentication

`dak` resolves credentials in this order:

1. **Explicit profile** (`--profile <name>`): only that profile from `~/.databrickscfg` is used; environment credentials are ignored.
2. **Environment variables**: `DATABRICKS_HOST` plus either `DATABRICKS_TOKEN` (personal access token) or `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` (OAuth M2M).
3. **Profile** named by `DATABRICKS_CONFIG_PROFILE`, else `DEFAULT`, from `~/.databrickscfg` (or the file in `DATABRICKS_CONFIG_FILE`).

Within a profile, the method is chosen by its keys: `token` -> personal access token; `client_id` + `client_secret` -> OAuth M2M; `auth_type = databricks-cli` -> OAuth U2M through the Databricks CLI. Any other `auth_type` (for example `azure-cli`) is rejected with a message listing the supported methods.

Tokens are kept in memory only, refreshed before they expire, and never written to logs or tool output.

### Option A - OAuth U2M through the Databricks CLI (recommended for personal use)

Manual steps:

1. Install or upgrade the Databricks CLI to 1.0.0 or later:
   - Windows: `winget install Databricks.DatabricksCLI` (or `winget upgrade Databricks.DatabricksCLI`).
   - macOS/Linux: see the [CLI installation guide](https://docs.databricks.com/aws/en/dev-tools/cli/install).
2. Log in once per workspace. This opens the browser and writes a profile with `auth_type = databricks-cli` to `~/.databrickscfg`:

   ```bash
   databricks auth login --host https://<workspace-host> --profile dev
   ```

3. Optional: pin a SQL warehouse by adding `warehouse_id = <id>` to the `[dev]` section of `~/.databrickscfg`.
4. Start the server with `--profile dev` (or set `DATABRICKS_CONFIG_PROFILE=dev`).

`dak` asks the CLI for a fresh token (`databricks auth token --profile dev`) when needed; the CLI owns the login, the token cache (`~/.databricks/token-cache.json`) and refresh. When the refresh token expires, tool calls return an error asking you to run `databricks auth login --profile dev` again; no server restart is needed.

### Option B - Personal access token

Manual steps:

1. In the workspace, open your user menu > **Settings** > **Developer** > **Access tokens** > **Manage** > **Generate new token**. Set a lifetime and copy the token. Workspace admins can disable personal access tokens; if the option is missing, use option A or C.
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
2. Generate an OAuth secret for it (admin settings > **Identity and access** > **Service principals** > the principal > **Secrets**). Copy the client ID and secret.
3. Grant it the permissions listed below, ideally read-only.
4. Provide the credentials through `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`, or a profile with `host`, `client_id` and `client_secret`.

`dak` exchanges them at `https://<workspace-host>/oidc/v1/token` (`client_credentials`, scope `all-apis`) and refreshes the token automatically.

### Permissions to grant

| Capability                                  | Required                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Any SQL tool                                | `CAN USE` on a SQL warehouse                                                               |
| Read data                                   | `USE CATALOG`, `USE SCHEMA` and `SELECT` on the objects                                    |
| `search_metadata`, tags in `describe_table` | Read access to `system.information_schema` (it only shows objects the identity can access) |
| `table_lineage`                             | Unity Catalog system tables (`system.access`) enabled by an admin, plus `SELECT` on them   |
| Writes (`--allow-writes`)                   | `MODIFY` and the DDL privileges you intend to allow                                        |

Recommendation: give agents an identity with read-only grants. The `dak` read-only guard is defense in depth, not a security boundary.

### Verify

```bash
dak doctor --profile dev
```

It checks authentication, identity, warehouse, `SELECT 1`, `information_schema`, lineage system tables, log storage, the Databricks CLI version and the write mode, and prints the next step for anything that fails. Exit code 1 means at least one required check failed.

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
- Binding to another address (`--host 0.0.0.0`) requires `DAK_HTTP_TOKEN`; clients must send `Authorization: Bearer <token>`. The token can also be set on loopback.
- All clients share the server's Databricks identity; client credentials are never forwarded to Databricks.

Clients point at the URL, for example `claude mcp add --transport http databricks http://127.0.0.1:8765/mcp` (add `--header "Authorization: Bearer <token>"` when a token is set), or an OpenCode entry with `"type": "remote"` and `"url": "http://127.0.0.1:8765/mcp"`.

## Tools

| Tool                                           | Purpose                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `list_warehouses`                              | SQL warehouses and the default one                                      |
| `list_catalogs`, `list_schemas`, `list_tables` | Browse Unity Catalog (`list_tables` accepts a substring or glob)        |
| `describe_table`                               | Columns, comments, primary/foreign keys, clustering, partitioning, tags |
| `search_metadata`                              | Find tables and columns by name or comment                              |
| `sample_table`                                 | First rows of a table (max 100)                                         |
| `execute_sql`                                  | One statement with `:name` parameters, bounded results                  |
| `get_statement`, `cancel_statement`            | Follow up on statements still running after 30 s                        |
| `table_lineage`                                | Upstream/downstream tables from lineage system tables                   |
| `search_logs`                                  | Search this server's operational logs                                   |

Suggested workflow for data questions (it replaces Genie): `search_metadata` -> `describe_table` -> `sample_table` -> `execute_sql`. The better your Unity Catalog comments, tags and keys, the better the agent's SQL.

### SQL safety and limits

- Read-only by default: one statement starting with `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `VALUES` or `FROM`; `WITH` statements that modify data are rejected. Enable writes with `--allow-writes` or `DAK_ALLOW_WRITES=true`.
- Results: 100 rows by default, capped by `DAK_MAX_ROWS` (default 1000) and by size; `truncated: true` tells the agent to aggregate or filter.
- Statements still running after 30 s return a `statement_id`.

## Coexistence with the official Databricks skills

The official skills ([databricks-agent-skills](https://github.com/databricks/databricks-agent-skills)) are installed with the Databricks CLI, not by this project. Some of them conflict with this MCP:

| Skill                                                                                                                                                             | Conflict                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `databricks-data-discovery`                                                                                                                                       | Sends every data question to Genie (`databricks genie ask`)                                                                        |
| `databricks-genie-agents`                                                                                                                                         | Genie                                                                                                                              |
| `databricks-unity-gateway`                                                                                                                                        | AI Gateway / Unity Gateway services                                                                                                |
| `databricks-core` and the skills that embed its commands (`databricks-dbsql`, `databricks-unity-catalog`, `databricks-metric-views`, `databricks-pipelines`, ...) | Tell the agent to run SQL and explore schemas with `databricks experimental aitools tools query`, `discover-schema` or `statement` |

To skip the Genie and gateway skills while keeping the useful ones (these still mention the CLI commands, so the tiebreak note below is still needed):

```bash
databricks aitools install --skills-only --skills databricks-core,databricks-dbsql,databricks-unity-catalog,databricks-metric-views,databricks-dabs,databricks-jobs,databricks-pipelines
```

**If the official skills are installed and include any conflicting skill, add the following tiebreak note to your global agent instructions** so the MCP takes precedence:

| Agent        | Global instructions file       |
| ------------ | ------------------------------ |
| Codex        | `~/.codex/AGENTS.md`           |
| OpenCode     | `~/.config/opencode/AGENTS.md` |
| Claude Code  | `~/.claude/CLAUDE.md`          |
| Other agents | Their global `AGENTS.md`       |

```markdown
## Databricks: MCP precedence

- For Databricks SQL execution and Unity Catalog metadata, use the `databricks` MCP server tools
  (`execute_sql`, `describe_table`, `search_metadata`, `sample_table`, `list_*`, `table_lineage`).
- Do not use `databricks experimental aitools tools query|discover-schema|statement`, `databricks genie ask`
  or Genie for those tasks while the MCP server is available, even if a Databricks skill says so.
  Fall back to the CLI only when the MCP server is unavailable.
- The Databricks skills remain the reference for everything else (bundles, jobs, pipelines, SQL features).
```

The server also sends MCP instructions with the same precedence, but not every client applies them, so keep the note.

## Operational logs

- Stored in SQLite at `<install dir>/.storage/logs.db` (override with `DAK_STORAGE_DIR`), shared by every `dak` process.
- Every tool call and resource read is an execution (UUID v7) with start/end time, status (`completed`, `failed`, `cancelled`) and its ordered log entries; server start/stop events belong to a lifecycle execution per process.
- Logged: tool name, arguments (including SQL text), duration, result summary (row count, truncation, statement id), errors with stack traces. Never logged: result rows, tokens or secrets (keys such as `token`, `secret`, `password`, `authorization` are redacted).
- Writes go through an in-memory queue flushed every 5 s or every 100 events in one transaction, and on shutdown. Only events still in the queue are lost if the process crashes.
- Retention: 90 days, purged at startup and every 24 h.
- `DAK_LOG_LEVEL` (`trace`, `debug`, `info` default, `warn`, `error`, `fatal`) filters stored entries.

Diagnostics through MCP:

| Resource                                  | Content                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `resource://logs/errors/recent`           | Latest error and fatal entries                   |
| `resource://logs/executions/recent`       | Latest executions                                |
| `resource://logs/execution/{executionId}` | One execution with all its entries               |
| `resource://logs/stats`                   | Executions, errors and warnings in the last 24 h |

The `search_logs` tool filters by `level`, `text`, `executionId`, `from`/`to` (ISO 8601) and `limit`.

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
| Log storage      | -                   | `DAK_STORAGE_DIR`                                     | `<install dir>/.storage`             |
| Log level        | -                   | `DAK_LOG_LEVEL`                                       | `info`                               |

## Troubleshooting

| Symptom                                                | Fix                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `No Databricks credentials found`                      | Follow one of the authentication options, then `dak doctor`             |
| `Could not get an OAuth token from the Databricks CLI` | `databricks auth login --profile <name>`                                |
| `Databricks CLI not found on PATH`                     | Install the CLI or use a personal access token                          |
| `[PERMISSION_DENIED] ...`                              | Ask an admin for the privilege named in the message                     |
| `No SQL warehouse is accessible`                       | Set `DATABRICKS_WAREHOUSE_ID` or get `CAN USE` on a warehouse           |
| `Read-only mode: ...`                                  | Expected; restart with `--allow-writes` only if writes are intended     |
| `Lineage is unavailable`                               | Lineage system tables are not enabled or not readable in this workspace |
| Statement still `RUNNING`                              | The warehouse is starting; call `get_statement`                         |

## Development

```bash
npm test                  # unit + end-to-end (stdio and HTTP against a local Databricks API stub)
npm run typecheck
npm run build
DAK_IT_PROFILE=dev npm run test:integration   # real workspace; optional DAK_IT_TABLE (default samples.nyctaxi.trips)
```

Tests use `node:test` and run the TypeScript sources directly (Node.js type stripping).
