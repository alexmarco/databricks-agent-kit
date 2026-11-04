import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, messageOf } from "../src/errors.ts";

test("messageOf gives the message of an Error, subclasses included", () => {
  assert.equal(messageOf(new Error("boom")), "boom");
  assert.equal(messageOf(new AuthError("no credentials")), "no credentials");
});

test("messageOf gives the string form of a value that is not an Error", () => {
  assert.equal(messageOf("plain text"), "plain text");
  assert.equal(messageOf(42), "42");
  assert.equal(messageOf(undefined), "undefined");
  assert.equal(messageOf({ code: "E" }), "[object Object]");
});
