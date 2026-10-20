# Publishing the project documentation with GitHub Pages

Status: research, 2026-10-20. Not a decision: adopting a toolchain needs an ADR (see [Caveats](#caveats-specific-to-this-repo)).

## Question and scope

The team wants `GLOSSARY.md`, `docs/design.md` and `docs/adr/*` published as a static site on GitHub Pages. This note covers:

1. Which tools to use: static site generator, TypeScript API reference, Markdown linter.
2. How they fit the workflow: local preview, CI build, deployment, GitFlow branches (`main`, `develop`, `feature/*`, `bugfix/*`, `hotfix/*`).
3. Caveats specific to this repository.

Out of scope: writing the configuration or workflow files. Nothing was implemented.

Repository facts checked:

- The repository is **public**. The GitHub API returns `"private": false` and `"visibility": "public"` for `alexmarco/databricks-agent-kit` (accessed 2026-10-20, [S10]). The auto-memory note that calls it private is stale.
- Stack: TypeScript ESM, `"engines": { "node": ">=22.18" }`, `typescript` `^7.0.2`, `tsc` build, `node:test`, Biome for lint and format (`package.json`, `biome.json`).
- Markdown is outside the format gate (ADR 0016). No Markdown linter is configured. `.gitignore` already whitelists `.markdownlint*` files.
- No existing research convention: no `research/`, `notes/` or `docs/research/` directory in the repository. This note creates `docs/research/`.
- Existing workflows: `ci.yml`, `codeql.yml`, `integration.yml`, `release.yml`, all with SHA-pinned actions (ADR 0016).

## Short answer

- **Recommended site generator: VitePress**, a Node-based tool. Its stable release on npm is `1.6.4` ([S13]). It needs one devDependency, reads Markdown directly, and runs on Node 22, which matches the project. The official VitePress guide now installs `vitepress@next` (a 2.0 alpha, `2.0.0-alpha.20` on npm) ([S13], [S14]). The stable-or-alpha choice is an open question.
- **Alternatives:** Docusaurus `3.10.2` (Node 20+, React, more packages) ([S11], [S12]). MkDocs with Material for MkDocs (Python): familiar to the user, but Material is in maintenance mode and MkDocs 1.x is unmaintained ([S8], [S9]).
- **API reference:** TypeDoc `0.28.20` with `typedoc-plugin-markdown` `4.14.1` ([S15], [S16]). **Blocked for now:** TypeDoc's peer dependency lists TypeScript 5.0.x through 6.0.x only ([S15]), and this project uses TypeScript 7.0.2. Not needed for the current documents (`GLOSSARY.md`, design, ADRs).
- **Markdown linter:** `markdownlint-cli2` `0.23.3` ([S17]), a devDependency. Optional, and it must be approved.
- **Hosting:** GitHub Pages for a public repository, source set to **GitHub Actions**, deployed from `main` only ([S1], [S2], [S3], [S4]).

## Comparison of options

| Option | Role | Language and runtime | Latest version (verified) | Added dependencies | Notes |
| --- | --- | --- | --- | --- | --- |
| VitePress | Static site generator | Node.js 22+ (official guide) | 1.6.4 stable; 2.0.0-alpha.20 under `next` | `vitepress` (1 devDependency) | Markdown-first, fast, small. Official guide points to the 2.x alpha [S13], [S14]. |
| Docusaurus | Static site generator | Node.js 20.0+ [S12] | 3.10.2 [S11] | `@docusaurus/core` plus React peers `react`, `react-dom`, `@mdx-js/react` (npm peer dependencies) | React-based. Heavier. Built-in docs versioning is unverified (not fetched). |
| MkDocs + Material for MkDocs | Static site generator | Python (`mkdocs` 1.6.1 requires Python >=3.8; `mkdocs-material` 9.7.7 requires >=3.8) [S18], [S19] | mkdocs 1.6.1, mkdocs-material 9.7.7 | Python toolchain (pip or uv) in CI and locally, not an npm package | Documentation source is Markdown plus one YAML file [S7]. Material in maintenance mode: no new features, critical fixes for at least 12 months from 2025-11-11 [S8]. MkDocs 1.x unmaintained [S9]. |
| Zensical | Static site generator (successor to Material) | Python 3.11+ [S20] | 0.0.71 on PyPI | Python toolchain | Built by the Material authors; described as compatible with MkDocs 1.x [S9]. Pre-1.0 release, maturity not verified. |
| TypeDoc + typedoc-plugin-markdown | TypeScript API reference | Node.js 18+ (`typedoc` engines) [S15] | typedoc 0.28.20, plugin 4.14.1 | 2 devDependencies; plugin peers `typedoc` 0.28.x [S16] | Blocked by the TypeScript 7 peer range [S15]. Not tested by install. |
| markdownlint-cli2 | Markdown linter | Node.js 22+ (`engines`) [S17] | 0.23.3 | 1 devDependency | Config files `.markdownlint-cli2.jsonc` and others [S21]. Not needed for the site itself. |

Python-to-Node mapping: MkDocs is the Python tool closest to the user's experience, and its source-format statement is verified ([S7]). Equivalences such as "Sphinx ~ MkDocs", "pip or uv ~ npm" and "mkdocstrings ~ TypeDoc" are analogies, not sourced here.

Why VitePress over the others, in short: one devDependency, Node only (no second language runtime in CI or for contributors), stable release available. Docusaurus is the choice if React customisation or built-in versioning (unverified) becomes necessary. MkDocs is the choice if the user prefers Python and accepts the maintenance-mode theme.

## Integration with the workflow

### Local preview

- VitePress: `npm add -D vitepress` (or `vitepress@next`), then `npx vitepress init` (setup wizard), `npm run docs:dev` for a hot-reload dev server, `vitepress build` for the static output ([S13]).
- Docusaurus: `npx create-docusaurus@latest <dir> classic` ([S12]).
- MkDocs: `pip` or `uv` install, then `mkdocs serve` (command not verified in this research).

### CI build (pull requests)

- A job on `pull_request` into `develop` and `main`, path-filtered to `docs/**`, `GLOSSARY.md`, `README.md` (or always on, since it is cheap): install with `npm ci`, run the site build, fail on error.
- ADR 0016: required check names are part of the rulesets. A new job added to the required checks needs the rulesets updated in the same change.

### Deployment to GitHub Pages

- Repository Settings > Pages > Build and deployment > Source: **GitHub Actions**. The "Deploy from a branch" option publishes files without a build step and is not suitable here ([S2]).
- Workflow outline (to implement later):
  - `on: push: branches: [main]` plus `workflow_dispatch`.
  - `build` job: checkout, `setup-node`, `npm ci`, site build, `actions/upload-pages-artifact` with the output directory as `path` (`v3` in its README; default `_site/`) ([S5]).
  - `deploy` job: `needs: build`, `environment: github-pages`, `permissions: pages: write, id-token: write`, `actions/deploy-pages` (`v4` in its README) ([S4]).
  - Protect the `github-pages` environment so only the default branch can deploy. GitHub recommends this rule ([S2]).
  - Pin actions to full commit SHAs, as ADR 0016 requires for all workflows. Resolve the SHAs at implementation time.
  - Deployment is skipped on pull requests ([S2]).
- `actions/configure-pages` enables Pages and exposes metadata ([S6]). Its page has no usage example, so its inputs are unverified; check its `action.yml` before use.

### Branch strategy (GitFlow, ADR 0016)

- Docs changes travel like code: `feature/*` or `bugfix/*` into `develop`, reviewed by pull request, checked by the build job.
- Publication happens only from `main`, so the published site moves when a `develop` to `main` release pull request is merged. A `hotfix/*` into `main` publishes immediately.
- Back-merge of `main` into `develop` does not redeploy the site, because the deploy job runs on `main`.
- Do not publish from `develop`: the site would show unreleased documents.

### Versioning

- Not needed for a first version: the repository has one tagged release line (`v0.1.0` is the first release, ADR 0016, `cliff.toml`), and releases are GitHub Releases, not npm packages.
- If versioned documentation is wanted later: Docusaurus is reported to have built-in versioning (unverified; its documentation was not fetched); for VitePress and MkDocs this needs extra tooling (not verified here).

## Caveats specific to this repo

- **Plan and visibility:** GitHub Pages is available for public repositories on GitHub Free ([S1]). The repository is public, so no plan change is needed. Everything in the published site is public, which matches the already-public repository, but no secrets, tokens or workspace-specific values must go into the docs (AGENTS.md).
- **Source setting:** The Pages source must be changed manually to GitHub Actions in the repository settings ([S2]). This is a GitHub setting, not a file, like the rulesets in ADR 0016.
- **Dependency policy:** Every option adds devDependencies (or a Python toolchain). AGENTS.md requires asking before adding a dependency. Biome, commitlint, husky and the TypeScript and `@types/node` devDependencies are already present (ADR 0016 added four devDependencies). The user must approve the site generator. `markdownlint-cli2` is a separate, optional approval.
- **TypeScript 7 and TypeDoc:** `npm ci` with TypeDoc would likely fail on the peer range (not tested by installing). Options: wait for TypeDoc support for TypeScript 7; pin TypeScript 6 for a docs-only install (changes the toolchain, needs approval); or skip the API reference. The API reference is not required by the current document set.
- **Material for MkDocs status:** Material is in maintenance mode since 2025-11-11 ([S8]). Adopting it means building on a theme that gets no new features.
- **Docs and ADRs in sync (AGENTS.md):** AGENTS.md requires an ADR for each relevant technical decision, and `docs/design.md` must be updated when the design changes. Adopting the docs toolchain is a decision, so it needs an ADR (not an edit of an old ADR). Publishing does not change this rule. ADRs are published as they are, never rewritten. A superseded ADR stays as it is.
- **Links:** `docs/adr/README.md` and `GLOSSARY.md` use relative `.md` links, which the site generator must rewrite or keep working (not verified per tool).
- **Language:** AGENTS.md requires English for all documents. The site language setting must match (unverified per tool).
- **Limits:** Pages sites have a 1 GB limit and a 10-minute deployment timeout; the soft limit of 10 builds per hour does not apply to custom Actions workflows ([S3]). Irrelevant for a small document set.
- **Memory note:** the auto-memory entry "private repo" is outdated (see the Scope section).

## Implementation steps (not done)

1. Get approval for the site generator (recommended: VitePress) and, if wanted, `markdownlint-cli2` and TypeDoc.
2. Write an ADR for the documentation toolchain and the publication policy (publish from `main`, English only, ADRs published as is).
3. Add the site configuration under `docs/` (for example `docs/.vitepress/config.*` for VitePress) and `package.json` scripts (`docs:dev`, `docs:build`).
4. Add `.github/workflows/docs.yml`: pull-request build, `main` deployment with the artifact and Pages actions pinned by SHA.
5. In repository settings: set Pages source to GitHub Actions; protect the `github-pages` environment to `main`.
6. Update the rulesets if the build job becomes a required check (ADR 0016 consequence).
7. Update `docs/design.md` and the ADR index (`docs/adr/README.md`).
8. Verify: local build, a pull-request build run, a deployment from `main`, and link checks on the published pages.

## Open questions

1. Accept VitePress as the site generator? Alternatives are Docusaurus (versioning, React) or MkDocs (Python, Material in maintenance mode). Also: stable `1.6.4` or the `2.0` alpha that the official guide now installs?
2. Is a TypeScript API reference required? If yes, TypeDoc needs either a TypeScript 7 supporting release or a TypeScript 6 docs install. If not, skip it.
3. Which documents are published? Proposed: `README.md`, `GLOSSARY.md`, `docs/design.md`, `docs/adr/*`. Keep `docs/research/` unpublished?
4. Deployment trigger: every push to `main`, or only when a GitHub Release is published?
5. Versioned docs, or only the latest state of `main`?
6. Is a Markdown linter (`markdownlint-cli2`) wanted, and should it run in CI? ADR 0016 keeps Markdown out of the format gate.
7. Custom domain? The default Pages URL is expected to be `https://alexmarco.github.io/databricks-agent-kit/` (not verified; confirm after the first deployment).
8. Update the auto-memory entry that calls the repository private?

## Sources

Accessed 2026-10-20 unless stated.

1. GitHub Docs, GitHub plans (GitHub Pages in public repositories, GitHub Free): https://docs.github.com/en/get-started/learning-about-github/githubs-plans
2. GitHub Docs, Configuring a publishing source for your GitHub Pages site (Deploy from a branch vs GitHub Actions, `github-pages` environment, deployment protection rule, skipped deploys on pull requests): https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
3. GitHub Docs, GitHub Pages limits (1 GB, 100 GB bandwidth, 10 builds per hour, 10-minute timeout, exception for custom Actions workflows): https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
4. actions/deploy-pages README (workflow example, `pages: write`, `id-token: write`, `environment: github-pages`, `@v4`): https://github.com/actions/deploy-pages
5. actions/upload-pages-artifact README (`path` default `_site/`, `retention-days`, `@v3`, 10 GB archive limit): https://github.com/actions/upload-pages-artifact
6. actions/configure-pages README (purpose only; no usage example found): https://github.com/actions/configure-pages
7. MkDocs home page (Markdown source files and a single YAML configuration file): https://www.mkdocs.org/
8. Material for MkDocs blog (2025-11-11 post: maintenance mode, no new features, 12-month support window for critical fixes; 2025-11-18 discussions note): https://squidfunk.github.io/mkdocs-material/blog/
9. Material for MkDocs blog (2026-02-18 post: MkDocs 1.x unmaintained, MkDocs 2.0 pre-release, Zensical compatible with MkDocs 1.x): https://squidfunk.github.io/mkdocs-material/blog/
10. GitHub API, repository metadata for alexmarco/databricks-agent-kit (`private: false`, `visibility: public`): https://api.github.com/repos/alexmarco/databricks-agent-kit
11. npm registry, `@docusaurus/core` 3.10.2 (latest tag, peer dependencies): https://registry.npmjs.org/@docusaurus/core
12. Docusaurus installation page (Node.js 20.0 or above; `npx create-docusaurus@latest my-website classic`): https://docusaurus.io/docs/installation
13. VitePress getting started (Node.js 22 or higher; `npm add -D vitepress@next`; `npx vitepress init`; `npm run docs:dev`): https://vitepress.dev/guide/getting-started ; npm registry `vitepress` dist-tags (latest 1.6.4, next 2.0.0-alpha.20): https://registry.npmjs.org/vitepress
14. npm registry, `vitepress` `1.6.4` and `2.0.0-alpha.20` engines: no `engines` field returned for 1.6.4.
15. npm registry, `typedoc` 0.28.20 (peerDependencies: typescript `5.0.x` to `6.0.x`; engines node `>= 18`): https://registry.npmjs.org/typedoc/0.28.20
16. npm registry, `typedoc-plugin-markdown` 4.14.1 (peerDependencies: typedoc `0.28.x`): https://registry.npmjs.org/typedoc-plugin-markdown/4.14.1
17. markdownlint-cli2 GitHub README (install commands, config file names, default glob) and npm registry 0.23.3 (engines node `>=22`): https://github.com/DavidAnson/markdownlint-cli2 ; https://registry.npmjs.org/markdownlint-cli2/0.23.3
18. PyPI, mkdocs 1.6.1 (requires_python `>=3.8`): https://pypi.org/pypi/mkdocs/json
19. PyPI, mkdocs-material 9.7.7 (requires_python `>=3.8`): https://pypi.org/pypi/mkdocs-material/json
20. PyPI, zensical 0.0.71 (requires_python `>=3.11`; summary "A modern static site generator built by the creators of Material for MkDocs"): https://pypi.org/pypi/zensical/json ; Zensical home page (no install or stability statement found): https://zensical.org/
21. markdownlint-cli2 GitHub README, configuration file list: https://github.com/DavidAnson/markdownlint-cli2
22. npm registry, `typescript` dist-tags (latest 7.0.2): https://registry.npmjs.org/typescript
23. Repository files: `AGENTS.md`, `package.json`, `biome.json`, `cliff.toml`, `.gitignore`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/codeql.yml`, `.github/workflows/integration.yml`, `.github/dependabot.yml`, `docs/adr/0016-ci-cd-pipeline-and-gitflow.md`, `docs/adr/README.md`, `docs/design.md`, `GLOSSARY.md`, `README.md`, paths relative to `C:/Users/AlejandroMarco/Documents/projects/databricks-agent-kit`.
