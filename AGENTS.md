# AGENTS.md

Instructions for coding agents and contributors working on `databricks-agent-kit`, an MCP server (`dak`) that gives coding agents governed SQL and Unity Catalog metadata access to Databricks.

## Language

- Write everything in English: code, identifiers, comments, commit messages and every document (README, design, ADRs, specs, plans).

## Project map

| Path             | Content                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `src/`           | TypeScript sources (ESM, run with Node.js type stripping, built by `tsc`) |
| `test/`          | `node:test` suites; `test/integration/` needs a real workspace            |
| `GLOSSARY.md`    | Design vocabulary and the terms of the statement lifecycle module         |
| `docs/design.md` | Current design                                                            |
| `docs/adr/`      | Architecture decision records, indexed in its `README.md`                 |

## Commands

```bash
npm test                  # unit and end-to-end tests
npm run typecheck
npm run build
DAK_IT_PROFILE=<profile> npm run test:integration   # real workspace, opt-in
```

Node.js 22.18 or later is required (type stripping is unflagged from that version).

## Working rules

- Develop test-first: reproduce the failure or write the new behavior as a failing test before the code.
- Keep changes minimal and follow the conventions of the surrounding code.
- Ask before adding a dependency. The runtime dependencies are deliberately few; the only addition so far is `parquet-wasm`, pinned to an exact version (see ADR 0004).
- Use only public Databricks REST APIs through `fetch` (ADR 0001). Do not add Databricks SDKs or drivers.
- Never write to stdout from the server in stdio mode: it carries the MCP protocol. Diagnostics go to the log service or stderr.
- Never log or return secrets, tokens or result rows.
- Record every relevant technical decision as an ADR in `docs/adr/` and update `docs/design.md` when the design changes. A superseded ADR is not rewritten: add a new one.
- The Unity Catalog permissions of the configured identity are the real security boundary. The read-only check is defense in depth.

## Issue tracker

- Work items are GitHub issues in `alexmarco/databricks-agent-kit`, managed with the `gh` CLI.
- A ticket has the title `<Topic> NN: <title>`, the sections "What to build", "Acceptance criteria" and "Blocked by" (`#N` references), and the label `ready-for-agent` when an agent can take it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues of `alexmarco/databricks-agent-kit`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Git

- Never commit directly to `main`. Work on a branch and keep commits atomic, one logical change each.
- Use Conventional Commits: `type(scope): description`.
- If a pre-commit or commit message check fails, fix the cause and commit again; never skip the hooks.
- Do not force-push shared branches.

## Repository mechanics

- `main` is the default branch. Work reaches `develop` first and `main` only through a release. GitHub reads repository configuration such as `.github/dependabot.yml` from `main`, so a change to it takes effect after the next release, or sooner through a `hotfix/*`. Confirm the effect on the branch GitHub reads before reporting a configuration change as done.
- A pull request needs one code-owner approval, and the maintainer is the only code owner. Open the pull request, report its checks, and ask the maintainer to merge it in the web UI with the bypass.
- Pull requests into `develop` are squash-merged and their title must be a Conventional Commit, because it becomes the commit and the release note. Pull requests into `main` are merged with a merge commit, never squashed. `protect-develop` and `protect-main` enforce the allowed methods.
- A release is three pull requests that the maintainer merges in the web UI with the bypass: the promotion `develop` into `main`, the release pull request that Release Please opens (it bumps `version` in `package.json`; never bump it by hand), and the `sync/main-into-develop` pull request that brings `main` back into `develop`. Report their checks and ask for the merge. The bot opens the last two with the `RELEASE_PLEASE_TOKEN` secret, which expires after a year (ADR 0022).
- Diagrams: read `docs/diagrams-src/README.md` before creating, editing or checking one.
