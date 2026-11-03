# ADR 0022: Releases with Release Please, squash merges into develop and an install script

- Status: Accepted
- Date: 2026-11-03

## Context

[ADR 0016](0016-ci-cd-pipeline-and-gitflow.md) computed the version with git-cliff from the tags and never committed it. After `v0.2.0` was published, `package.json` still said `0.1.0`. `dak --version` and the `version` that the MCP server announces read `package.json`, and the README installs from a clone, so every clone reported the wrong version. Only the release tarball carried the right one.

The same ADR merged every pull request with a merge commit, so each atomic commit of a branch reached the release notes. The notes of `v0.2.0` list six lines for one feature (the metadata cache), and those of `v0.1.0` list internal steps and fixes to code that was never released.

The maintainer wants the release flow to need as little intervention as possible.

## Decision

This ADR supersedes the release workflow, the "version is not committed" rule and the "merge commits only" rule of ADR 0016. Everything else in ADR 0016 stays.

- **Release Please replaces git-cliff.** It runs in manifest mode (`release-please-config.json`, `.release-please-manifest.json`, starting at `0.2.0`). On every push to `main` it reads the Conventional Commits since the last tag. With a releasable commit (`feat`, `fix`, `perf` or a breaking change) it opens or updates a pull request that bumps `version` in `package.json` and `package-lock.json`. Merging that pull request creates the tag `vX.Y.Z` and the GitHub Release, and a second job of `release.yml` attaches the tarball and `scripts/install.sh` to it. The version is now committed, so a clone, the tarball and the tag agree.
- **No changelog file.** `skip-changelog` keeps `CHANGELOG.md` out of the repository; GitHub Releases stays the changelog. The package stays private and is not published to npm.
- **`RELEASE_PLEASE_TOKEN`.** A fine-grained personal access token (this repository only, `contents` and `pull requests` in write mode, valid for one year) creates the release pull request and the sync pull request. Pull requests created with `GITHUB_TOKEN` do not start workflows, so the required checks would never run on them.
- **Squash into `develop`, merge commit into `main`.** Pull requests into `develop` are squash-merged: the title of the pull request is the commit and the line in the release notes, and the atomic commits stay in the branch and on the pull request page. The `commits` check also validates the title with commitlint, and re-runs when the title is edited. Pull requests into `main` keep the merge commit. The promotion must not be squashed, because that would hide its `feat` and `fix` commits from Release Please.
- **`main` stops requiring an up-to-date branch.** With squash merges into `develop`, `main` is never an ancestor of `develop`, so a strict `main` would mark every promotion as out of date. The checks still run on the proposed merge result of each pull request.
- **Back-merge `main` into `develop` is automatic.** `sync.yml` runs on every push to `main`. `scripts/ci/sync-main-into-develop.sh` pushes `sync/main-into-develop` (develop plus a merge of `main`) only when that would change the tree of `develop`, and the workflow opens the pull request into `develop`. After the sync pull request is squash-merged, the trees agree and the next run opens nothing. A conflict fails the workflow.
- **Branch policy.** `release-please--*` branches are accepted into `main`, and `sync/*` branches into `develop`.
- **Install script.** `scripts/install.sh` checks Node.js 22.18 and npm, resolves the latest release (or `DAK_VERSION`) and runs `npm install --global` on its tarball. It installs nothing else, uses no `sudo` and does not change the PATH. It is attached to every release, so `releases/latest/download/install.sh` always serves the script of the latest release. The README documents two ways to install: cloning the repository and this script.

## Consequences

- The maintainer merges three pull requests per release in the web UI, with the bypass: the promotion `develop` to `main`, the release pull request and the sync pull request. The bot creates the last two with the maintainer's token, so the maintainer cannot approve them.
- The token expires after a year and must be renewed. When it is missing or expired, the `Release` and `Sync develop` workflows fail on `main`.
- The rulesets are GitHub settings, not files. After this change is merged, `protect-develop` allows only squash merges, and `protect-main` stops requiring an up-to-date branch. The maintainer applies them, as in ADR 0016.
- The `workflow_dispatch` dry run of the old release workflow is gone. The release pull request shows the next version and the notes before anything is published.
- The commits of a feature branch no longer appear one by one in the history of `develop`. A `fix:` commit inside a feature that is not released yet no longer appears in the notes either. Only the title of the pull request counts.
- The release exists for a short time before the tarball and `install.sh` are attached. An installation in that window fails and works if repeated.
- Not verified before the first release on `main`: that Release Please accepts its release pull request merged with a merge commit, and that the notes are published without `CHANGELOG.md`. If the first fails, `main` will also accept squash merges for that pull request only.
