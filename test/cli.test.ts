import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("dak --version prints the package version", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const { stdout } = await run(process.execPath, [cliPath, "--version"]);
  assert.equal(stdout.trim(), pkg.version);
});

test("dak --help lists the commands and the environment variables", async () => {
  const { stdout } = await run(process.execPath, [cliPath, "--help"]);
  assert.match(stdout, /mcp \[options\]/);
  assert.match(stdout, /doctor \[options\]/);
  assert.match(stdout, /branch-policy <source> <target>/);
  assert.match(stdout, /DAK_HTTP_TOKEN/);
  assert.match(stdout, /DAK_EXPORT_DIR/);
  assert.match(stdout, /DAK_EXPORT_MAX_BYTES/);
});

test("invalid options fail with exit code 1 and the usage", async () => {
  await assert.rejects(run(process.execPath, [cliPath, "mcp", "--transport", "sse"]), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? "", /Allowed choices are stdio, http/);
    assert.match(error.stderr ?? "", /Usage: dak mcp/);
    return true;
  });
});

test("dak branch-policy exits 0 without output for an allowed pull request", async () => {
  const { stdout, stderr } = await run(process.execPath, [cliPath, "branch-policy", "feature/ci-cd", "develop"]);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("dak branch-policy exits 1 and prints the reason to stderr for a rejected pull request", async () => {
  await assert.rejects(run(process.execPath, [cliPath, "branch-policy", "feature/ci-cd", "main"]), (error: { code?: number; stdout?: string; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr ?? "", /^dak: A pull request into "main" must come from "develop" or a "hotfix\/\*" branch, not from "feature\/ci-cd"\./);
    return true;
  });
});
