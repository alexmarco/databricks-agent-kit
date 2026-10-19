import { test } from "node:test";
import assert from "node:assert/strict";
import { describeArguments } from "../src/logging/arguments.ts";

test("cuts a long statement to 4096 characters and states how many were dropped", () => {
  const described = describeArguments({ statement: "x".repeat(5000) });
  assert.equal(described.statement, `${"x".repeat(4096)}…[+904 chars]`);
});

test("keeps a short statement as is", () => {
  assert.deepEqual(describeArguments({ statement: "SELECT 1" }), { statement: "SELECT 1" });
});

test("replaces parameters by their names and types so values are never logged", () => {
  const described = describeArguments({ parameters: [{ name: "id", value: "secret", type: "INT" }] });
  assert.deepEqual(described, { parameters: [{ name: "id", type: "INT" }] });
});

test("passes other keys through", () => {
  assert.deepEqual(describeArguments({ catalog: "main", row_limit: 5 }), { catalog: "main", row_limit: 5 });
});
