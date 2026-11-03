import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
const latestTagUrl = "https://github.com/alexmarco/databricks-agent-kit/releases/tag/v0.2.0";

interface Scenario {
  nodeVersion?: string | null;
  npm?: boolean;
  dakOnPath?: boolean;
  latestLookupFails?: boolean;
  npmInstallFails?: boolean;
  dakVersion?: string;
}

function writeStub(directory: string, name: string, body: string) {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function shellDirectory() {
  const candidates = (process.env.PATH ?? "").split(delimiter);
  const found = candidates.find(
    (directory) => existsSync(join(directory, "sh")) || existsSync(join(directory, "sh.exe")),
  );
  assert.ok(found, "a POSIX sh is on the PATH");
  return found;
}

function runInstaller(scenario: Scenario, environment: Record<string, string> = {}) {
  const stubs = mkdtempSync(join(tmpdir(), "dak-install-"));
  const npmLog = join(stubs, "npm.log");
  try {
    if (scenario.nodeVersion !== null) {
      writeStub(stubs, "node", `echo "v${scenario.nodeVersion ?? "24.1.0"}"`);
    }
    if (scenario.npm !== false) {
      writeStub(
        stubs,
        "npm",
        `if [ "$1" = "prefix" ]; then echo "/fake/prefix"; exit 0; fi
echo "$*" >> "${npmLog.replaceAll("\\", "/")}"
exit ${scenario.npmInstallFails ? 1 : 0}`,
      );
    }
    writeStub(stubs, "curl", scenario.latestLookupFails ? "exit 22" : `printf '%s' "${latestTagUrl}"`);
    if (scenario.dakOnPath) {
      writeStub(stubs, "dak", `echo "${scenario.dakVersion ?? "0.2.0"}"`);
    }
    const result = spawnSync("sh", [scriptPath], {
      encoding: "utf8",
      env: { PATH: `${stubs}${delimiter}${shellDirectory()}`, ...environment },
    });
    const npmCalls = existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n") : [];
    return { ...result, npmCalls };
  } finally {
    rmSync(stubs, { recursive: true, force: true });
  }
}

// The Windows runner of the CI runs its own curl instead of the stub, so the lookup of the latest release cannot be simulated there.
test("installs the latest release and prints the installed version", { skip: process.platform === "win32" }, () => {
  const result = runInstaller({ dakOnPath: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.npmCalls, [
    "install --global https://github.com/alexmarco/databricks-agent-kit/releases/download/v0.2.0/databricks-agent-kit-0.2.0.tgz",
  ]);
  assert.match(result.stdout, /Installed: 0\.2\.0/);
});

test("installs the version in DAK_VERSION without looking up the latest release", () => {
  for (const requested of ["0.1.0", "v0.1.0"]) {
    const result = runInstaller({ dakOnPath: true, latestLookupFails: true }, { DAK_VERSION: requested });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.npmCalls, [
      "install --global https://github.com/alexmarco/databricks-agent-kit/releases/download/v0.1.0/databricks-agent-kit-0.1.0.tgz",
    ]);
  }
});

test("accepts the minimum Node.js version", () => {
  const result = runInstaller({ nodeVersion: "22.18.0", dakOnPath: true }, { DAK_VERSION: "0.2.0" });
  assert.equal(result.status, 0, result.stderr);
});

test("fails when Node.js is missing", () => {
  const result = runInstaller({ nodeVersion: null });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /Node\.js 22\.18 or later is required, but node was not found/);
  assert.deepEqual(result.npmCalls, []);
});

test("fails when Node.js is older than the minimum", () => {
  for (const nodeVersion of ["20.11.1", "22.17.9"]) {
    const result = runInstaller({ nodeVersion });
    assert.equal(result.status, 1, `${nodeVersion}: ${result.stdout}${result.stderr}`);
    assert.ok(result.stderr.includes(`Node.js 22.18 or later is required, found ${nodeVersion}.`), result.stderr);
    assert.deepEqual(result.npmCalls, []);
  }
});

test("fails when npm is missing", () => {
  const result = runInstaller({ npm: false });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /npm was not found/);
});

test("fails when DAK_VERSION is not a version", () => {
  for (const requested of ["latest", "0.2", "v1.x.0"]) {
    const result = runInstaller({}, { DAK_VERSION: requested });
    assert.equal(result.status, 1, requested);
    assert.ok(result.stderr.includes(`DAK_VERSION must look like 0.2.0 or v0.2.0, got "${requested}".`), result.stderr);
    assert.deepEqual(result.npmCalls, []);
  }
});

// Skipped on Windows for the same reason as the test of the latest release.
test("fails when the latest release cannot be found", { skip: process.platform === "win32" }, () => {
  const result = runInstaller({ latestLookupFails: true });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /Could not find the latest release/);
  assert.deepEqual(result.npmCalls, []);
});

test("fails when npm cannot install the tarball", () => {
  const result = runInstaller({ npmInstallFails: true }, { DAK_VERSION: "0.2.0" });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /npm could not install .*databricks-agent-kit-0\.2\.0\.tgz/);
});

test("says so when dak is not on the PATH", () => {
  const result = runInstaller({ dakOnPath: false }, { DAK_VERSION: "0.2.0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dak is not on your PATH.*\/fake\/prefix/s);
});
