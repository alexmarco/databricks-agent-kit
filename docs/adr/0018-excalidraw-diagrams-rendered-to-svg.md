# ADR 0018: Excalidraw diagrams rendered to SVG with headless Chrome

- Status: Accepted
- Date: 2026-10-20

## Context

[ADR 0017](0017-documentation-site-on-github-pages.md) renders the documentation diagrams with Mermaid. The maintainer
wants the diagrams in the hand-drawn style of Excalidraw, which the Mermaid output cannot produce.

Excalidraw has no VitePress plugin, and embedding its editor would add React to a Vue site (ADR 0017). The options were:

1. Draw the scenes in Excalidraw, and render them to SVG with `@excalidraw/utils`, which needs a browser to measure text.
2. Write the SVG by hand, without new dependencies. The result does not look like Excalidraw.
3. Draw the scenes on excalidraw.com and commit the exported files.

The maintainer chose option 1. Its new development dependencies need the maintainer's approval (`AGENTS.md`), which was
given.

## Decision

- **Sources** are `.excalidraw` files in `docs/diagrams-src/`. They open and edit in excalidraw.com. Each source has a
  top-level `title` string, which becomes the accessible name of its SVG.
- **Rendering** is done by `scripts/render-diagrams.mjs`. It bundles `@excalidraw/utils` with esbuild and runs the export
  in Chrome or Chromium, controlled through the DevTools protocol. The script writes `docs/public/diagrams/<name>.svg`.
- **Browser lookup:** the `CHROME_PATH` variable when set, then the default install locations of Windows and macOS, then
  the `PATH`. Without a browser the script stops with an error that names `CHROME_PATH`.
- **Dependencies**, pinned exactly: `@excalidraw/utils` 0.1.7 and `esbuild` 0.28.2, as devDependencies. The script runs
  on Node.js 22.18 or later, which provides the `WebSocket` global it uses.
- **Committed output.** The SVG files are committed, so building the site does not need a browser. CI does not render
  diagrams.
- **Waiting for the export.** The script waits for the promise returned by the export through the DevTools protocol. It
  does not read the DOM after a fixed time, because that returned before the export finished.
- **Backgrounds.** Scenes are exported with an opaque white background, so each diagram reads the same in the light and
  dark themes of the site.

## Consequences

- Re-rendering needs a Chrome or Chromium binary on the machine that runs the script. Setting `CHROME_PATH` on a CI
  runner is enough to render there. No CI job renders today; a check that the committed SVGs match a fresh render is a
  separate decision.
- The export bundle is about 20 MB while it runs. It is not committed.
- Excalidraw does not keep unknown top-level fields when it saves a file. A source re-saved on excalidraw.com needs its
  `title` added back, and the script fails with a message when it is missing.
- Mermaid stays installed until every Mermaid block is replaced. When that is done, this decision replaces the diagram
  part of ADR 0017, and the Mermaid dependencies are removed.
