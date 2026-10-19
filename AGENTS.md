# AGENTS.md

Instructions for coding agents and contributors working on `databricks-agent-kit`, an MCP server (`dak`) that gives coding agents governed SQL and Unity Catalog metadata access to Databricks.

## Language

- Write everything in English: code, identifiers, comments, commit messages and every document (README, design, ADRs, specs, plans).

## Project map

| Path             | Content                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `src/`           | TypeScript sources (ESM, run with Node.js type stripping, built by `tsc`) |
| `test/`          | `node:test` suites; `test/integration/` needs a real workspace            |
| `docs/design.md` | Current design                                                            |
| `docs/adr/`      | Architecture decision records, indexed in its `README.md`                 |

## Commands

```bash
npm test                  # unit and end-to-end tests
npm run typecheck
npm run build
DAK_IT_PROFILE=<profile> npm run test:integration   # real workspace, opt-in
```

Node.js 22.13 or later is required.

## Working rules

- Develop test-first: reproduce the failure or write the new behavior as a failing test before the code.
- Keep changes minimal and follow the conventions of the surrounding code.
- Ask before adding a dependency. The runtime dependencies are deliberately few; the only addition so far is `parquet-wasm`, pinned to an exact version (see ADR 0004).
- Use only public Databricks REST APIs through `fetch` (ADR 0001). Do not add Databricks SDKs or drivers.
- Never write to stdout from the server in stdio mode: it carries the MCP protocol. Diagnostics go to the log service or stderr.
- Never log or return secrets, tokens or result rows.
- Record every relevant technical decision as an ADR in `docs/adr/` and update `docs/design.md` when the design changes. A superseded ADR is not rewritten: add a new one.
- The Unity Catalog permissions of the configured identity are the real security boundary. The read-only check is defense in depth.

## Git

- Never commit directly to `main`. Work on a branch and keep commits atomic, one logical change each.
- Use Conventional Commits: `type(scope): description`.
- If a pre-commit or commit message check fails, fix the cause and commit again; never skip the hooks.
- Do not force-push shared branches.
