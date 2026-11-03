# Diagrams

Excalidraw sources of the documentation diagrams ([ADR 0018](../adr/0018-excalidraw-diagrams-rendered-to-svg.md)).
Each `<name>.excalidraw` renders to `docs/public/diagrams/<name>.svg`. This folder is excluded from the site build.

## Workflow

1. Agree the style of a new kind of diagram with the maintainer on one diagram, then draw the rest.
2. Edit the source in excalidraw.com or the VS Code Excalidraw editor, or edit its JSON. A source the maintainer edited by
   hand is the source of truth: change its JSON in place and keep its layout.
3. Add back the top-level `"title"` field whenever an editor drops it. It becomes the accessible name of the SVG, and the
   render script stops without it.
4. Render with `node scripts/render-diagrams.mjs`. It needs Chrome or Chromium; set `CHROME_PATH` if it is not found.
5. Embed the SVG with alt text that describes the diagram: `![...](/diagrams/<name>.svg)`. In `docs/design.md`, which
   GitHub also renders, use the relative path `./public/diagrams/<name>.svg`.
6. Commit the source and its SVG together.

## Style

- **Corners:** rectangles use `roundness: { type: 3, value: 12 }`.
- **Arrows:** elbow arrows with rounded corners (`elbowed: true`). Dashed for a call without the token.
- **Text:** font family 5 (Excalifont). Box text 20 to 24, labels 20 in `#6B7280`.
- **Groups:** a dashed panel with its title above it, 28 in `#1e1e1e`, and an optional subtitle inside.
- **Palette** (stroke / fill):

  | Role                          | Stroke    | Fill      |
  | ----------------------------- | --------- | --------- |
  | Agent                         | `#7A4FD6` | `#F1EBFF` |
  | dak, running states, data     | `#2F6FDB` | `#E8F1FF` |
  | Databricks, success           | `#1E9E62` | `#E6F7EE` |
  | Checks, cloud storage, cancel | `#E07B00` | `#FFF4E5` |
  | Risk, failure, rejection      | `#C81E1E` | `#FDE8E8` |
  | Local stores                  | `#6B7280` | `#FFFFFF` |

- **Width:** about 1000 units at most. The docs column is about 690 px wide, so a wider diagram shrinks its text.
- **Representation:** pick the shape that fits the idea: an ordered rule list for ordered checks, nesting for
  composition, a state layout for a lifecycle.
- **Sequence diagrams** stay as Mermaid blocks in the page: one `rect` block per tool call or phase with a `Note` that
  names it, translucent `rgba` fills that read in both themes, long messages split with `<br/>`, and a per-diagram
  `config` that narrows the actors (`width: 120`, `actorMargin: 40`).

## Verify

- Render twice: every SVG must be byte-identical.
- `npm run docs:build` passes with no dead links.
- Look at each changed SVG once and at its page once. The SVG has an opaque white background, so one theme is enough.
  Look at a Mermaid diagram in the dark theme as well.
- Run headless Chrome with its own `--user-data-dir`. Sharing the profile of a running Chrome hands the job to that
  instance and no screenshot is written.
