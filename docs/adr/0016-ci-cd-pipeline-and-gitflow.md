# ADR 0016: CI/CD pipeline, simplified GitFlow and automated releases

- Status: Accepted
- Date: 2026-10-20

## Context

The repository had no continuous integration or delivery. Nothing checked formatting, lint, types, tests, coverage or vulnerable dependencies before a change reached `main`. The branch rules were written conventions only, and releases were not defined. The repository is public and accepts outside contributions, so the maintainer wants a pipeline that is simple to understand, cheap to maintain and safe to open to contributors (spec: issue #11).

## Decision

- **Simplified GitFlow.** Branches are `main`, `develop`, `feature/*`, `bugfix/*` and `hotfix/*`. Work branches from `develop` and reaches it through a pull request. A `hotfix/*` branches from `main`, merges into `main`, and is back-merged into `develop`. There are no `release/*` branches: a release is a pull request from `develop` into `main`.
- **Branch policy.** `scripts/ci/branch-policy.sh <source> <target>` allows a pull request into `main` only from `develop` or `hotfix/*`, and into `develop` only from `feature/*`, `bugfix/*` or `hotfix/*`. Any other branch name is rejected, with the reason printed.
- **Rulesets.** `main` and `develop` each have a ruleset that blocks direct pushes and deletions, requires a pull request with one approval from a code owner, requires resolved conversations and a branch up to date with its base, and requires the status checks below. `.github/CODEOWNERS` assigns every path to the maintainer. The maintainer is the only bypass actor, in pull-request-only mode, so the checks still apply to them.
- **Merge commits only.** Squash and rebase merging are disabled, so the atomic commits of a branch stay in the history.
- **Biome instead of ESLint and Prettier.** Biome (`@biomejs/biome`) formats and lints the TypeScript sources. The typescript-eslint parser does not support TypeScript 7, which the project uses. Markdown is outside the format gate.
- **Local hooks.** husky (installed by `npm ci`) runs `pre-commit`, which calls `npm run format:check` and `npm run lint`, and `commit-msg`, which runs commitlint with `@commitlint/config-conventional`. Commit messages follow Conventional Commits. These four packages are the only new dev dependencies (Biome, `@commitlint/cli`, `@commitlint/config-conventional`, husky). No runtime dependency is added.
- **Coverage gate.** `npm run test:coverage` runs `node --test` with the built-in coverage and minimums of 95% lines, 85% branches and 90% functions. The minimums sit below the current coverage (about 98%, 91% and 93.5%) and are raised by hand when coverage rises.
- **CI workflow** (`.github/workflows/ci.yml`, on pull requests into `develop` and `main`):
  - `quality` (Ubuntu, Node.js 24): lint, format check, type check, build, and `npm audit --omit=dev --audit-level=high`.
  - `test`: matrix of Ubuntu on Node.js 22.18 and 24, and Windows on Node.js 24, running `npm run test:coverage`.
  - `commits`: commitlint over the commits of the pull request. GitHub merge commits are skipped by the default ignores.
  - `branch-policy`: runs the branch policy script with the head and base refs.
  - `dependency-review`: reviews dependency changes of the pull request.
  - CodeQL (`.github/workflows/codeql.yml`): JavaScript and TypeScript analysis on pull requests and weekly on `main`.
  - Required checks: `quality`, each `test` leg, `commits`, `branch-policy`, `dependency-review` and the CodeQL analysis.
- **Integration workflow** (`.github/workflows/integration.yml`): manual `workflow_dispatch` only, never on pull requests. It runs in the `integration` environment, which requires the maintainer's approval and accepts only `develop` and `main`. It authenticates to the Databricks workspace with a dedicated service principal and OAuth machine-to-machine; host, client id and client secret are environment secrets. The integration tests use these variables when all three are set, and the profile in `DAK_IT_PROFILE` otherwise.
- **Release workflow** (`.github/workflows/release.yml`, on pushes to `main`). git-cliff (pinned GitHub action, no npm dependency) computes the next version and the release notes from the Conventional Commits since the last tag. Only `feat`, `fix` and `perf` commits are releasable. Without releasable commits nothing is published. Otherwise the workflow packs the tarball with the version set for the build only, creates the `vX.Y.Z` tag and publishes a GitHub Release with the notes and the tarball. There is no changelog file: GitHub Releases is the changelog. The package stays private and is not published to npm.
- **Workflow hardening.** Each workflow defaults to `contents: read`; write permissions are granted per job. Third-party actions are pinned to full commit hashes. Dependabot updates npm and GitHub Actions weekly, grouped, into `develop`, with the `chore` commit prefix.
- **Minimum Node.js 22.18** (`engines`). The end-to-end tests run `src/*.ts` in child processes and need type stripping without a flag, which Node.js enables from 22.18. On 22.13 nine end-to-end tests fail (commit `de3d3e2`). The test matrix runs the minimum version, so the declared range stays true.

## Consequences

- Required check names are part of the rulesets. Renaming a job or a matrix leg needs the rulesets updated in the same change.
- Rulesets, the `integration` environment and the service principal are GitHub settings, not files in the repository. They are applied by the maintainer after the pull request that introduces the pipeline is merged, so that pull request is not blocked by them. Until then `main` and `develop` are briefly unprotected; this is accepted because the history was scanned for secrets and the repository is already public.
- Contributors need Node.js 22.18 or later. `npm ci` installs the hooks.
- Commit messages are validated and become the release notes, so a commit with a wrong type is not listed in them.
- Known debts:
  - Biome `style/noNonNullAssertion` reports 96 warnings. They do not fail the lint gate and are fixed in a later change.
  - The first release is `v0.1.0`, computed from the full history (`initial_tag` in `cliff.toml`).
  - `chore!` does not bump the major version (git-cliff limitation). A breaking change should use a releasable type, such as `feat!` or `fix!`.
