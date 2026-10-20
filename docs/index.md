---
layout: home

hero:
  name: databricks-agent-kit
  text: Governed Databricks access for coding agents
  tagline: An MCP server (dak) that lets your agent run SQL on a SQL warehouse and inspect Unity Catalog metadata, with read-only mode by default and persistent operational logs.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: Architecture
      link: /architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/alexmarco/databricks-agent-kit

features:
  - icon: 🔎
    title: Metadata discovery
    details: Browse catalogs, schemas and tables, search by name or comment, and describe tables with keys, tags, samples and lineage.
  - icon: 🛡️
    title: Read-only by default
    details: Each statement is checked before it runs. Writes need an explicit switch, and the Unity Catalog permissions of the identity stay the real security boundary.
  - icon: 📦
    title: Large results as files
    details: Export a full result to CSV, Parquet or SQLite without sending the rows through the agent's context.
  - icon: 🧾
    title: Operational logs
    details: Every tool call is recorded in a local SQLite store, with redacted parameters and no result rows. Agents can read the logs through MCP resources.
  - icon: 🔐
    title: Three authentication methods
    details: OAuth through the Databricks CLI, personal access tokens, or OAuth machine-to-machine with a service principal.
  - icon: 🧩
    title: Works with your agent
    details: Registers in Claude Code, Codex, OpenCode and Cursor over stdio, or as one shared Streamable HTTP server.
---

## What it is

`dak` is a [Model Context Protocol](https://modelcontextprotocol.io) server. Your coding agent calls five tools to answer
questions about data in Databricks: it finds the right table, looks at its structure and a sample, and runs a bounded SQL
query. The server talks only to public Databricks REST APIs.

## What it is not

- **Not a model.** Databricks-served models, AI Gateway, Unity Gateway and Genie are out of scope. Your agent keeps its own
  model subscription.
- **Not a security boundary by itself.** The read-only check is defense in depth. The permissions of the identity you
  configure in Unity Catalog decide what can be read or changed.
- **Not a Databricks-managed MCP server.** It runs on your machine, or on a host you control.

## How it fits together

```mermaid
flowchart LR
  agent["Coding agent"]
  dak["dak MCP server"]
  dbx["Databricks workspace"]

  agent -- "MCP over stdio or Streamable HTTP" --> dak
  dak -- "REST: Statement Execution, Unity Catalog" --> dbx

  classDef agentStyle fill:#F1EBFF,stroke:#7A4FD6,color:#1F2937
  classDef serverStyle fill:#E8F1FF,stroke:#2F6FDB,color:#1F2937
  classDef workspaceStyle fill:#E6F7EE,stroke:#1E9E62,color:#1F2937
  class agent agentStyle
  class dak serverStyle
  class dbx workspaceStyle
```

## Where to go next

- New here? Start with the [quickstart](/guide/quickstart).
- Choosing how `dak` signs in? Read [authentication](/guide/authentication) and compare the three methods.
- Setting up an agent? See [connecting your agent](/guide/agents).
- Wondering what the agent may or may not do? Read [read-only mode](/guide/read-only) and the [security model](/security).
