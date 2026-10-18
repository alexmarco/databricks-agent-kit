import { test } from "node:test";
import assert from "node:assert/strict";
import { uuidv7 } from "../src/logging/uuid.ts";

test("uuidv7 has version 7, RFC variant and embeds the timestamp", () => {
  const id = uuidv7(0x0193ebc0c7a8);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id.slice(0, 13).replace("-", ""), "0193ebc0c7a8");
});

test("uuidv7 sorts by time", () => {
  assert.ok(uuidv7(1_000) < uuidv7(2_000));
  assert.notEqual(uuidv7(5), uuidv7(5));
});
