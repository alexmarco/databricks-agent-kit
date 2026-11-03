# ADR 0020: Dependabot reads its configuration from main

- Status: Accepted
- Date: 2026-11-03

## Context

[ADR 0019](0019-dependabot-branches-and-mermaid-pin.md) added an `ignore` rule for the major updates of `mermaid` to
`.github/dependabot.yml`, merged into `develop`. Dependabot reads its configuration from the default branch, `main`,
even when its pull requests target `develop`. The rule therefore had no effect: after it was merged, Dependabot still
proposed Mermaid 12 in pull request #51.

## Decision

- The rule stays in `.github/dependabot.yml` and takes effect when `develop` is released into `main`.
- Until then, Dependabot's own state holds the ignore. It was set with `@dependabot ignore mermaid major version` on
  pull request #51, and Dependabot confirmed it and replaced that pull request with #52, without Mermaid 12.
- A change to Dependabot's configuration that must apply before the next release goes through a `hotfix/*` into `main`.

## Consequences

- `develop` and `main` can disagree about Dependabot's configuration between releases. `AGENTS.md` records this, so a
  configuration change is checked on `main` before it is reported as done.
- The ignore set by the comment survives a later change to the configuration file. `@dependabot unignore mermaid`
  removes it when `vitepress-plugin-mermaid` supports a newer Mermaid major.
