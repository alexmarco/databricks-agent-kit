import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBranchPolicy } from "../src/branch-policy.ts";

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

for (const { source, target, allowed } of cases) {
  test(`${source} into ${target} is ${allowed ? "allowed" : "rejected"}`, () => {
    assert.equal(checkBranchPolicy(source, target).allowed, allowed);
  });
}

test("a rejection reason is a sentence that names the source branch", () => {
  for (const { source, target } of cases.filter((testCase) => !testCase.allowed)) {
    const decision = checkBranchPolicy(source, target);
    assert.ok(!decision.allowed, `${source} into ${target} is rejected`);
    assert.match(decision.reason, /^A pull request .*\.$/);
    assert.ok(decision.reason.includes(`"${source}"`), `reason for ${source} into ${target} names ${source}`);
  }
});
