import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { exportId, exportPath, sanitizeExportName } from "../src/export/paths.ts";

test("sanitizeExportName replaces invalid characters and removes leading dots", () => {
  assert.equal(sanitizeExportName("../../etc/x"), "_.._etc_x");
  const backslash = sanitizeExportName("..\\x");
  assert.ok(!backslash.includes("\\") && !backslash.includes("/"));
  assert.equal(sanitizeExportName("sales 2024 (final)"), "sales_2024__final_");
  assert.equal(sanitizeExportName("ok-name_1.v2"), "ok-name_1.v2");
});

test("sanitizeExportName falls back to export when the name is missing or empty", () => {
  assert.equal(sanitizeExportName(undefined), "export");
  assert.equal(sanitizeExportName(""), "export");
  assert.equal(sanitizeExportName("..."), "export");
});

test("sanitizeExportName cuts the name at 64 characters", () => {
  assert.equal(sanitizeExportName("a".repeat(100)), "a".repeat(64));
});

test("sanitizeExportName never returns a dot name or a path separator", () => {
  for (const name of [".", "..", "...", "./", "../", "..\\", "/", "\\", "a/b\\c", "/etc/passwd", "C:\\Windows"]) {
    const result = sanitizeExportName(name);
    assert.notEqual(result, ".", name);
    assert.notEqual(result, "..", name);
    assert.ok(!result.includes("/") && !result.includes("\\"), name);
  }
});

test("sanitizeExportName prefixes Windows reserved device names with an underscore", () => {
  const reserved = ["CON", "PRN", "AUX", "NUL", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`])];
  for (const device of reserved) {
    assert.equal(sanitizeExportName(device), `_${device}`);
    assert.equal(sanitizeExportName(device.toLowerCase()), `_${device.toLowerCase()}`);
    assert.equal(sanitizeExportName(`${device}.txt`), `_${device}.txt`);
  }
  assert.equal(sanitizeExportName("Con.tar.gz"), "_Con.tar.gz");
  assert.equal(sanitizeExportName("CONSOLE"), "CONSOLE");
  assert.equal(sanitizeExportName("COM10"), "COM10");
  assert.equal(sanitizeExportName("COM0"), "COM0");
  assert.ok(sanitizeExportName(`CON.${"a".repeat(100)}`).length <= 64);
});

test("exportId joins the sanitized name and the full statement id", () => {
  assert.equal(exportId("sales", "01f0abcd-9999"), "sales-01f0abcd-9999");
  assert.equal(exportId(undefined, "01f0abcd-9999"), "export-01f0abcd-9999");
  assert.equal(exportId("../x", "01f0abcd-9999"), "_x-01f0abcd-9999");
  const uuid = "01f0abcd-1234-1a2b-9c8d-0123456789ab";
  assert.equal(exportId("a".repeat(100), uuid), `${"a".repeat(64)}-${uuid}`);
});

test("exportId tells apart statement ids that share their first characters", () => {
  // Databricks statement ids are time-ordered: ids of statements minutes apart share their first 8 characters.
  assert.notEqual(
    exportId(undefined, "01f0abcd-1111-1a2b-9c8d-0123456789ab"),
    exportId(undefined, "01f0abcd-2222-1a2b-9c8d-0123456789ab"),
  );
});

test("exportId treats the statement id as untrusted text", () => {
  assert.equal(exportId("sales", "../../etc/passwd"), "sales-.._.._etc_passwd");
  assert.equal(exportId("sales", "..\\..\\x"), "sales-.._.._x");
  assert.equal(exportId("sales", "CON"), "sales-CON");
  const id = exportId("sales", "a/b\\c/d\\e/f");
  assert.ok(!id.includes("/") && !id.includes("\\"));
});

test("exportPath returns the file shape of each format", () => {
  assert.equal(exportPath("/data/exports", "sales-01f0abcd", "csv"), join("/data/exports", "sales-01f0abcd.csv"));
  assert.equal(exportPath("/data/exports", "sales-01f0abcd", "sqlite"), join("/data/exports", "sales-01f0abcd.db"));
  assert.equal(exportPath("/data/exports", "sales-01f0abcd", "parquet"), join("/data/exports", "sales-01f0abcd"));
});
