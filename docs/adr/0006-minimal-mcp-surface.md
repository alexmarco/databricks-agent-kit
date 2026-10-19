# ADR 0006: Minimal MCP surface of 5 tools

- Status: Accepted
- Date: 2026-10-19

## Context

The 12 original tools take about 1155 tokens of definitions, plus 128 of instructions (measured with `o200k_base`). The most expensive are `execute_sql` (225) and `search_logs` (131). With fewer tools the agent also chooses better.

## Decision

Five tools: `list_objects`, `describe_table`, `search_metadata`, `execute_sql` (with `export`) and `get_statement` (with `wait_seconds` and `cancel`). The list of warehouses moves to the resource `resource://databricks/warehouses` and `search_logs` is removed in favor of the `resource://logs/*` resources.

## Consequences

- The cost of the definitions is expected to drop by half; it will be measured when implemented.
- Each tool gains optional parameters, which makes their descriptions slightly more complex.
- The public contract changes: clients that use the original tools must be updated.
