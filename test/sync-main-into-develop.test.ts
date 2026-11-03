import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/ci/sync-main-into-develop.sh", import.meta.url));
const identity = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(directory: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", env: { ...process.env, ...identity } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(directory: string, branch: string, file: string, content: string) {
  git(directory, "switch", "--quiet", branch);
  writeFileSync(join(directory, file), content);
  git(directory, "add", file);
  git(directory, "commit", "--quiet", "-m", `change ${file}`);
  git(directory, "push", "--quiet", "origin", branch);
}

/** A bare origin with main and develop at the same commit, and a clone of it. */
function createRepositories() {
  const root = mkdtempSync(join(tmpdir(), "dak-sync-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, clone);
  git(clone, "switch", "--quiet", "-c", "main");
  writeFileSync(join(clone, "package.json"), '{"version":"0.2.0"}\n');
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "initial");
  git(clone, "push", "--quiet", "origin", "main");
  git(clone, "switch", "--quiet", "-c", "develop");
  git(clone, "push", "--quiet", "origin", "develop");
  return { root, origin, clone };
}

function runSync(directory: string) {
  return spawnSync("bash", [scriptPath], { cwd: directory, encoding: "utf8", env: { ...process.env, ...identity } });
}

function withRepositories(body: (repositories: ReturnType<typeof createRepositories>) => void) {
  const repositories = createRepositories();
  try {
    body(repositories);
  } finally {
    rmSync(repositories.root, { recursive: true, force: true });
  }
}

const syncBranch = "sync/main-into-develop";

function remoteHasBranch(origin: string, branch: string) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: origin }).status === 0;
}

test("opens nothing when main adds nothing to develop", () => {
  withRepositories(({ origin, clone }) => {
    commitFile(clone, "develop", "feature.txt", "feature\n");
    const result = runSync(clone);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changed=false/);
    assert.equal(remoteHasBranch(origin, syncBranch), false);
  });
});

test("opens nothing when develop already has the changes of main in a squash commit", () => {
  withRepositories(({ origin, clone }) => {
    commitFile(clone, "main", "package.json", '{"version":"0.3.0"}\n');
    commitFile(clone, "develop", "package.json", '{"version":"0.3.0"}\n');
    const result = runSync(clone);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changed=false/);
    assert.equal(remoteHasBranch(origin, syncBranch), false);
  });
});

test("pushes a branch that merges main into develop when main has new content", () => {
  withRepositories(({ origin, clone }) => {
    commitFile(clone, "develop", "feature.txt", "feature\n");
    commitFile(clone, "main", "package.json", '{"version":"0.3.0"}\n');
    const developTip = git(clone, "rev-parse", "origin/develop");
    const mainTip = git(clone, "rev-parse", "origin/main");

    const result = runSync(clone);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changed=true/);
    assert.equal(git(origin, "rev-parse", syncBranch).length > 0, true);
    assert.equal(git(origin, "rev-parse", `${syncBranch}^1`), developTip);
    assert.equal(git(origin, "rev-parse", `${syncBranch}^2`), mainTip);
    assert.equal(git(origin, "show", `${syncBranch}:package.json`), '{"version":"0.3.0"}');
    assert.equal(git(origin, "show", `${syncBranch}:feature.txt`), "feature");
    assert.equal(git(origin, "rev-parse", "develop"), developTip, "develop itself is untouched");
  });
});

test("updates the branch with the new commits of main on a second run", () => {
  withRepositories(({ origin, clone }) => {
    commitFile(clone, "main", "package.json", '{"version":"0.3.0"}\n');
    assert.match(runSync(clone).stdout, /changed=true/);
    commitFile(clone, "main", "hotfix.txt", "hotfix\n");

    const result = runSync(clone);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changed=true/);
    assert.equal(git(origin, "show", `${syncBranch}:hotfix.txt`), "hotfix");
  });
});

test("fails without pushing when main and develop conflict", () => {
  withRepositories(({ origin, clone }) => {
    commitFile(clone, "main", "package.json", '{"version":"0.3.0"}\n');
    commitFile(clone, "develop", "package.json", '{"version":"0.4.0"}\n');

    const result = runSync(clone);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflict/i);
    assert.equal(remoteHasBranch(origin, syncBranch), false);
  });
});
