# Quickstart

This page takes you from an empty machine to a first SQL query from your agent. It uses OAuth through the Databricks CLI,
the recommended method for personal use. The other methods are in [authentication](/guide/authentication).

## Requirements

- **Node.js 22.18 or later.** The project is developed on Node.js 24. The log store uses the built-in `node:sqlite`
  module.
- **A Databricks workspace** with Unity Catalog and at least one SQL warehouse you can use.
- **Databricks CLI 1.0.0 or later** for OAuth login.

## 1. Install the server

```bash
git clone https://github.com/alexmarco/databricks-agent-kit.git
cd databricks-agent-kit
npm ci
npm run build
npm link            # optional: puts `dak` on your PATH
dak --version
```

Without `npm link`, run the server as `node <absolute-path>/dist/cli.js`.

::: warning Windows
Some MCP clients cannot launch the `.cmd` shim that `npm link` creates. In those clients, use `node` followed by the
absolute path to `dist/cli.js`.
:::

## 2. Log in to the workspace

```bash
databricks auth login --host https://<workspace-host> --profile dev
```

The command opens the browser and writes a profile named `dev` with `auth_type = databricks-cli` to `~/.databrickscfg`.
The CLI owns the login, the token cache and the refresh. `dak` asks the CLI for a fresh token when it needs one.

Optional: pin a SQL warehouse by adding `warehouse_id = <id>` to the `[dev]` section of `~/.databrickscfg`. Without it,
`dak` picks a running warehouse, then a serverless one, then the first it can use.

## 3. Check the setup

```bash
dak doctor --profile dev
```

`dak doctor` checks authentication, identity, warehouse, a `SELECT 1`, `information_schema`, lineage system tables,
result download, the export directory, log storage, the Databricks CLI version and the write mode. It prints the next step
for anything that fails. Exit code `1` means at least one required check failed.

## 4. Register the server in your agent

Claude Code, for example:

```bash
claude mcp add --scope user databricks -- dak mcp --profile dev
```

Other agents are in [connecting your agent](/guide/agents).

## 5. Ask a data question

Start a session in your agent and ask a question about a table you can read. The agent follows the workflow the tools
suggest:

1. `search_metadata` or `list_objects` to find the table.
2. `describe_table` to read its columns, comments and keys, with `sample_rows` for a quick look.
3. `execute_sql` to run the query. Large results come back truncated; ask the agent to aggregate or to export.

::: tip Better comments, better SQL
The agent writes better SQL when the Unity Catalog tables have comments, tags and primary or foreign keys. Those are the
first thing to improve when answers are poor.
:::

## Next steps

- Choose the right [authentication](/guide/authentication) method for a shared or unattended setup.
- Read [read-only mode](/guide/read-only) to know what the agent can and cannot do.
- Keep the [troubleshooting](/guide/troubleshooting) page at hand.
