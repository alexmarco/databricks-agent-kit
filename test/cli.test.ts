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
