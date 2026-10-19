import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep } from "../src/abort.ts";

const pendingTimers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

test("sleep resolves after the wait", async () => {
  const startedAt = Date.now();
  await sleep(20);
  assert.ok(Date.now() - startedAt >= 15);
});

test("sleep rejects with the signal's reason at once and releases its timer", async () => {
  const baseline = pendingTimers();
  const controller = new AbortController();
  const pending = sleep(60_000, controller.signal);
  assert.equal(pendingTimers(), baseline + 1);
  const reason = new Error("stop");
  controller.abort(reason);
  await assert.rejects(pending, reason);
  assert.equal(pendingTimers(), baseline);
});

test("sleep with an already aborted signal rejects without starting a timer", async () => {
  const baseline = pendingTimers();
  const reason = new Error("stop");
  await assert.rejects(sleep(60_000, AbortSignal.abort(reason)), reason);
  assert.equal(pendingTimers(), baseline);
});
