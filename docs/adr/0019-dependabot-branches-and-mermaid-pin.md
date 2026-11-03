# ADR 0019: Dependabot branches in the branch policy, and Mermaid pinned to 11

- Status: Accepted
- Date: 2026-11-03

## Context

Dependabot opens its weekly update pull requests into `develop` from branches named `dependabot/<ecosystem>/develop/...`
([ADR 0016](0016-ci-cd-pipeline-and-gitflow.md)). The branch policy allowed only `feature/*`, `bugfix/*` and `hotfix/*`
into `develop`, so the `branch-policy` check failed on every one of them. Pull requests #47 and #48 showed it.

Pull request #48 also bumped `mermaid` from 11.17.2 to 12.2.0. `vitepress-plugin-mermaid` 2.0.17 declares the peer
range `10 || 11`, so `npm ci` fails with `ERESOLVE` and every job that installs dependencies fails with it.
[ADR 0017](0017-documentation-site-on-github-pages.md) already pinned Mermaid 11 for that reason, but nothing kept
Dependabot from proposing 12.

## Decision

- **Branch policy.** `scripts/ci/branch-policy.sh` also allows `dependabot/*` into `develop`. `dependabot/*` into `main`
  stays rejected, because Dependabot targets `develop` only.
- **Mermaid pin.** `.github/dependabot.yml` ignores the `version-update:semver-major` updates of `mermaid`. Patch and
  minor updates continue. The ignore is removed when `vitepress-plugin-mermaid` supports a newer Mermaid major.

## Consequences

- Dependabot pull requests pass `branch-policy`. The other checks and the maintainer's approval still apply to them.
- A new Mermaid major needs a manual decision, taken together with the plugin.
