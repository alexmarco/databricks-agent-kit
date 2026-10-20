# Coexistence with Databricks skills

The official Databricks skills ([databricks-agent-skills](https://github.com/databricks/databricks-agent-skills)) are
installed with the Databricks CLI, not by this project. Some of them conflict with this server, because they send the agent
to Genie, to the AI Gateway, or to CLI commands that run SQL outside `dak`.

## Conflicting skills

| Skill | Conflict |
| --- | --- |
| `databricks-data-discovery` | Sends every data question to Genie (`databricks genie ask`) |
| `databricks-genie-agents` | Genie |
| `databricks-unity-gateway` | AI Gateway and Unity Gateway services |
| `databricks-core`, and the skills that embed its commands (`databricks-dbsql`, `databricks-unity-catalog`, `databricks-metric-views`, `databricks-pipelines`, ...) | Tell the agent to run SQL and explore schemas with `databricks experimental aitools tools query`, `discover-schema` or `statement` |

## Install only the useful skills

To skip the Genie and gateway skills and keep the others:

```bash
databricks aitools install --skills-only --skills databricks-core,databricks-dbsql,databricks-unity-catalog,databricks-metric-views,databricks-dabs,databricks-jobs,databricks-pipelines
```

These skills still mention the CLI commands, so the precedence note below is still needed.

## Add the precedence note

If the official skills are installed and include any conflicting skill, add this note to your global agent instructions so
that the MCP server takes precedence.

| Agent | Global instructions file |
| --- | --- |
| Codex | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Claude Code | `~/.claude/CLAUDE.md` |
| Other agents | Their global `AGENTS.md` |

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
