import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, DatabricksApiError } from "../src/client.ts";
import type { AuthProvider } from "../src/auth.ts";

const auth: AuthProvider = { host: "https://ws.example", method: "pat", profileWarehouseId: undefined, getToken: async () => "tok-secret" };

function stubFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

function client(responses: Array<Response | Error>) {
  const stub = stubFetch(responses);
  const delays: number[] = [];
  const api = createClient(auth, { fetch: stub.fetch, sleep: async (ms) => { delays.push(ms); } });
  return { api, calls: stub.calls, delays };
}

test("GET sends bearer token and skips undefined query values", async () => {
  const { api, calls } = client([Response.json({ ok: 1 })]);
  const result = await api.get<{ ok: number }>("/api/2.1/unity-catalog/schemas", { catalog_name: "main", page_token: undefined, max_results: 10 });
  assert.deepEqual(result, { ok: 1 });
  assert.equal(calls[0]!.url, "https://ws.example/api/2.1/unity-catalog/schemas?catalog_name=main&max_results=10");
  assert.equal(new Headers(calls[0]!.init?.headers).get("authorization"), "Bearer tok-secret");
});

test("POST sends a JSON body", async () => {
  const { api, calls } = client([Response.json({ id: "s1" })]);
  await api.post("/api/2.0/sql/statements", { statement: "SELECT 1" });
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(calls[0]!.init?.body, JSON.stringify({ statement: "SELECT 1" }));
  assert.equal(new Headers(calls[0]!.init?.headers).get("content-type"), "application/json");
});

test("retries 429 and 503 with backoff and honours Retry-After", async () => {
  const { api, delays } = client([
    new Response("{}", { status: 429, headers: { "retry-after": "2" } }),
    new Response("{}", { status: 503 }),
    Response.json({ ok: true }),
  ]);
  assert.deepEqual(await api.get("/x"), { ok: true });
  assert.deepEqual(delays, [2000, 1000]);
});

test("gives up after the retry budget", async () => {
  const { api, calls } = client([503, 503, 503, 503].map((status) => new Response("{}", { status })));
  await assert.rejects(api.get("/x"), DatabricksApiError);
  assert.equal(calls.length, 4);
});

test("network errors are retried for GET but not for POST", async () => {
  const get = client([new TypeError("fetch failed"), Response.json({ ok: 1 })]);
  assert.deepEqual(await get.api.get("/x"), { ok: 1 });
  const post = client([new TypeError("fetch failed")]);
  await assert.rejects(post.api.post("/x", {}), /fetch failed/);
  assert.equal(post.calls.length, 1);
});

test("4xx errors are not retried and are mapped to actionable messages", async () => {
  const cases: Array<[number, unknown, RegExp]> = [
    [403, { error_code: "PERMISSION_DENIED", message: "User does not have SELECT on table x" }, /\[PERMISSION_DENIED\].*SELECT on table x.*GRANT/],
    [404, { error_code: "RESOURCE_DOES_NOT_EXIST", message: "Catalog 'nope' does not exist." }, /\[RESOURCE_DOES_NOT_EXIST\].*nope/],
    [400, { error_code: "FEATURE_DISABLED", message: "Lineage is not enabled" }, /\[FEATURE_DISABLED\].*not available in this workspace/],
    [401, { error_code: "UNAUTHENTICATED", message: "Invalid token" }, /\[UNAUTHENTICATED\].*databricks auth login/],
    [400, { error_code: "INVALID_PARAMETER_VALUE", message: "bad id" }, /\[INVALID_PARAMETER_VALUE\].*bad id/],
  ];
  for (const [status, body, pattern] of cases) {
    const { api, calls } = client([Response.json(body, { status })]);
    await assert.rejects(api.get("/x"), (error: unknown) => {
      assert.ok(error instanceof DatabricksApiError);
      assert.equal(error.status, status);
      assert.equal(error.errorCode, (body as { error_code: string }).error_code);
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /tok-secret/);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("non-JSON error bodies are reported with the HTTP status", async () => {
  const { api } = client([new Response("<html>Bad gateway</html>", { status: 400 })]);
  await assert.rejects(api.get("/x"), /HTTP 400.*Bad gateway/);
});
