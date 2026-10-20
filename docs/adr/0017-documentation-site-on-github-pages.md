# ADR 0017: Documentation site on GitHub Pages with VitePress

- Status: Accepted
- Date: 2026-10-20

## Context

The project documentation lives in the README, `docs/design.md` and the ADRs. The README mixes installation, usage,
reference and design in one long file, and nothing renders diagrams or groups the material by reader task. The
repository is public, so the documentation should be published as a website that reads well for people who did not write
the code: a quickstart, an explanation of the three authentication methods and their privileges, the read-only limits,
agent examples, the capabilities (exports, logs), and an architecture overview with diagrams.

The site generator must work with the existing stack, which is Node.js and TypeScript, and must not add a second language
runtime. Dependencies need the maintainer's approval (`AGENTS.md`).

## Decision

- **Generator: VitePress 1.6.4**, pinned exactly. It is stable, runs on Node.js 22 and 24, and reads Markdown directly. The
  2.0 alpha that the official guide now installs is not used. Docusaurus and MkDocs were compared and rejected; see
  `docs/research/github-pages-documentation.md`.
- **Source and output.** The site is built from `docs/` (`docs/.vitepress/config.mts`). The base path is
  `/databricks-agent-kit/`. `docs/research/` is excluded from the build. `GLOSSARY.md` and the root `README.md` are not part
  of the site.
- **Diagrams.**
  - Mermaid through `vitepress-plugin-mermaid` 2.0.17, with `mermaid` 11.17.2 as its peer dependency. The plugin's peer
    range excludes Mermaid 12, so Mermaid 11 is pinned. The diagrams use a shared theme and `classDef` fills with dark
    text, so they read in light and dark mode. Flowchart labels are plain SVG text (`htmlLabels: false`) with a wide
    wrapping width, because wrapped multi-line labels were clipped in the rendered output.
  - Excalidraw is not integrated. There is no VitePress plugin for it, and embedding `@excalidraw/excalidraw` would add
    React to a Vue site. Excalidraw-style overview diagrams are rendered to SVG and committed under `docs/public/diagrams/`.
- **Publication.** GitHub Pages with the source set to **GitHub Actions**. The workflow `.github/workflows/docs.yml` builds
  the site on pull requests into `develop` and `main`, and on pushes to `main` it deploys through the `github-pages`
  environment. Deployment does not wait for a release. `workflow_dispatch` allows a manual deployment.
- **Versioning.** The site shows the current state of `main`, not a versioned set. This is the consequence of deploying on
  every push to `main`.
- **README.** The README becomes a summary of the documentation, and the documentation takes precedence over it. The README
  is not changed by this decision.
- **ADRs and the design document** are published as they are. A superseded ADR is not rewritten.

## Consequences

- New development dependencies: `vitepress`, `vitepress-plugin-mermaid` and `mermaid`. None of them is a runtime dependency.
  `npm audit --omit=dev`, which the `quality` job runs, is unaffected. The full audit reports advisories in development
  dependencies: `vite` (high, through `vitepress` 1.6.4) and `vitepress` (moderate) have no fixed release, and
  `vitepress-plugin-mermaid` has not been released since 2024-09-24.
- A new workflow is added, and its `docs` job must be added to the required status checks of `develop` and `main`
  (see ADR 0016).
- Repository settings change once, by the maintainer: Pages source set to GitHub Actions, and the `github-pages`
  environment limited to the `main` branch.
- Documentation changes reach readers on merge to `main`, before the next release. The site therefore may describe changes
  that are not yet released.
- A change to the documentation does not create a release. The release workflow only publishes `feat`, `fix` and `perf`
  commits (ADR 0016).
- `design.md` gets a section for the documentation site, and the ADR index lists this decision.
