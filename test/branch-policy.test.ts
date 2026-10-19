import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/ci/branch-policy.sh", import.meta.url));

const cases: Array<{ source: string; target: string; allowed: boolean }> = [
  { source: "feature/ci-cd", target: "develop", allowed: true },
  { source: "bugfix/null-rows", target: "develop", allowed: true },
  { source: "hotfix/token-leak", target: "develop", allowed: true },
  { source: "hotfix/token-leak", target: "main", allowed: true },
  { source: "develop", target: "main", allowed: true },
  { source: "feature/ci-cd", target: "main", allowed: false },
  { source: "develop", target: "develop", allowed: false },
  { source: "main", target: "develop", allowed: false },
  { source: "my-branch", target: "develop", allowed: false },
  { source: "my-branch", target: "main", allowed: false },
  { source: "feature/ci-cd", target: "release/1.0.0", allowed: false },
];

function checkBranchPolicy(source: string, target: string) {
  return spawnSync("bash", [scriptPath, source, target], { encoding: "utf8" });
}

for (const { source, target, allowed } of cases) {
  test(`${source} into ${target} is ${allowed ? "allowed" : "rejected"}`, () => {
    const result = checkBranchPolicy(source, target);
    assert.equal(result.status, allowed ? 0 : 1);
    assert.equal(result.stdout, "");
  });
}

test("a rejection prints a reason that names the source branch to stderr", () => {
  for (const { source, target } of cases.filter((testCase) => !testCase.allowed)) {
    const result = checkBranchPolicy(source, target);
    assert.match(result.stderr, /^branch-policy: A pull request .*\.\n$/);
    assert.ok(result.stderr.includes(`"${source}"`), `reason for ${source} into ${target} names ${source}`);
  }
});
