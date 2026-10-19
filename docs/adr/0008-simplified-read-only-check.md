# ADR 0008: Simplified read-only check

- Status: Accepted
- Date: 2026-10-19

## Context

The current check lets Databricks analyze the statement: first `DESCRIBE QUERY`, which only accepts queries, and if parsing fails, `EXPLAIN` and an examination of the name of the plan root. It fails closed and executes nothing. Its costs:

- One extra call to the warehouse for every query and two for every command.
- The `EXPLAIN` branch depends on Databricks texts (the name of the plan root, `PARSE_SYNTAX_ERROR` and "Error occurred during query planning"); if they change, legitimate commands are rejected.
- With the warehouse stopped, the check is cancelled after 50 s.

Latency was not measured in a real workspace.

## Decision

Accept without an extra call the statements that start with `SHOW`, `DESCRIBE`, `DESC` or `EXPLAIN` as a whole word, preceded only by spaces, tabs or line breaks, and that hold no `;` except at the end. Comments are not skipped: a statement that starts with a comment goes through `DESCRIBE QUERY`. All other statements require `DESCRIBE QUERY`. The analysis of the `EXPLAIN` plan is removed.

An earlier draft skipped leading comments. Review found that a scanner of ours can disagree with the Databricks lexer (a bare `\r` ends a `--` comment, a backslash before a line break continues it, and `SHOW_x` or `SHOWé` are identifiers that merely start with the keyword), so a write could take the fast path. The strict rule needs no knowledge of the Databricks lexer.

## Consequences

- Read commands cost no extra call; queries cost one.
- The fast path depends on no comment handling, so it cannot disagree with the Databricks lexer; anything that is not a plain leading read keyword is analysed by Databricks itself.
- A read command preceded by a comment is rejected in read-only mode; the error tells the agent to remove the comment.
- The Statement Execution API rejects several statements in a single call.
- The real boundary remains the Unity Catalog permissions of the identity.
- Note added after the final review of the export iteration: that multi-statement rejection was never verified, and if it does not hold, the `DESCRIBE QUERY` call itself could run a trailing write. Read-only mode therefore rejects, before any call, every statement with a `;` before its last non-whitespace character; a `;` inside a literal is rejected too and must be passed as a `:name` parameter. A read keyword followed by a `:` (a SQL-scripting label) no longer takes the fast path.
