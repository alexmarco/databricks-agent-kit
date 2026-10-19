import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimitedLogger } from "../src/logging/rate-limit.ts";

test("emits once per interval and reports how many calls were suppressed", () => {
  let clock = 0;
  const emitted: number[] = [];
  const log = createRateLimitedLogger(
    (suppressed) => emitted.push(suppressed),
    60_000,
    () => clock,
  );
  for (const time of [0, 10_000, 20_000]) {
    clock = time;
    log();
  }
  assert.deepEqual(emitted, [0]);
  clock = 70_000;
  log();
  assert.deepEqual(emitted, [0, 2]);
});
