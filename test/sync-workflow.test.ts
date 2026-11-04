import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/sync.yml", import.meta.url), "utf8");

test("the step that pipes the sync script runs in a shell with pipefail, so a conflict fails the workflow", () => {
  const step = workflow.split(/\n {6}- name: /).find((block) => block.startsWith("Prepare the sync branch"));
  assert.ok(step, "the Prepare the sync branch step exists");
  assert.match(step, /\| tee /, "the step pipes the script into GITHUB_OUTPUT");
  // GitHub runs `bash -e {0}` by default; only an explicit `shell: bash` adds `-o pipefail`.
  assert.match(step, /^ {8}shell: bash$/m);
});
