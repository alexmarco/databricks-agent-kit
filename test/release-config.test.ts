import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readJson(path: string) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

const packageJson = readJson("package.json");
const manifest = readJson(".release-please-manifest.json");
const config = readJson("release-please-config.json");

test("the Release Please manifest holds the version of package.json", () => {
  assert.equal(manifest["."], packageJson.version);
});

test("package-lock.json holds the version of package.json", () => {
  const lock = readJson("package-lock.json");
  assert.equal(lock.version, packageJson.version);
  assert.equal(lock.packages[""].version, packageJson.version);
});

test("Release Please tags releases as vX.Y.Z and keeps no changelog file", () => {
  const rootPackage = config.packages["."];
  assert.equal(rootPackage["release-type"], "node");
  assert.equal(rootPackage["include-component-in-tag"], false);
  assert.equal(rootPackage["skip-changelog"], true);
});

test("only feat, fix and perf commits appear in the release notes", () => {
  const visibleTypes = config["changelog-sections"].filter((section: { hidden?: boolean }) => !section.hidden);
  assert.deepEqual(
    visibleTypes.map((section: { type: string }) => section.type),
    ["feat", "fix", "perf"],
  );
});
