import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, DatabricksApiError, redactPath, type RequestEvent, type RetryEvent } from "../src/client.ts";
import { DakError } from "../src/errors.ts";
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

test("absolute URLs to another origin never receive the token", async () => {
  const { api, calls } = client([]);
  await assert.rejects(api.get("https://evil.example/api/2.0/sql/statements/st1/result/chunks/1"), /Refusing to send credentials/);
  assert.equal(calls.length, 0);
});

test("non-JSON error bodies are reported with the HTTP status", async () => {
  const { api } = client([new Response("<html>Bad gateway</html>", { status: 400 })]);
  await assert.rejects(api.get("/x"), /HTTP 400.*Bad gateway/);
});

test("every fetch call receives an abort signal", async () => {
  const { api, calls } = client([Response.json({ ok: 1 }), Response.json({ ok: 2 })]);
  await api.get("/x");
  await api.post("/x", {});
  for (const call of calls) assert.ok(call.init?.signal instanceof AbortSignal);
});

test("a timeout is retried for GET and reported as a DakError once retries are exhausted", async () => {
  const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const retried = client([timeout(), Response.json({ ok: 1 })]);
  assert.deepEqual(await retried.api.get("/x"), { ok: 1 });
  assert.equal(retried.calls.length, 2);

  const exhausted = client([timeout(), timeout(), timeout(), timeout()]);
  await assert.rejects(exhausted.api.get("/api/2.0/sql/statements/01f0abcd-1234"), (error: unknown) => {
    assert.ok(error instanceof DakError);
    assert.match(error.message, /timed out after 60 s/);
    assert.match(error.message, /\/api\/2\.0\/sql\/statements\/:id/);
    return true;
  });
  assert.equal(exhausted.calls.length, 4);
});

test("a timeout on POST is not retried", async () => {
  const { api, calls } = client([new DOMException("The operation was aborted due to timeout", "TimeoutError")]);
  await assert.rejects(api.post("/x", {}), (error: unknown) => error instanceof DakError && /timed out/.test(error.message));
  assert.equal(calls.length, 1);
});

test("Retry-After is capped at 30 s", async () => {
  const { api, delays } = client([new Response("{}", { status: 429, headers: { "retry-after": "3600" } }), Response.json({ ok: true })]);
  await api.get("/x");
  assert.deepEqual(delays, [30_000]);
});

test("onRetry and onRequest report retries and the time of the final attempt only", async () => {
  const retries: RetryEvent[] = [];
  const requests: RequestEvent[] = [];
  let clock = 1_000;
  const stub = stubFetch([new Response("{}", { status: 503 }), Response.json({ ok: true })]);
  const api = createClient(auth, {
    fetch: async (url, init) => {
      clock += 120;
      return stub.fetch(url, init);
    },
    sleep: async () => { clock += 500; },
    now: () => clock,
    onRetry: (event) => retries.push(event),
    onRequest: (event) => requests.push(event),
  });
  await api.get("/api/2.0/sql/statements/01f0abcd-1234?x=1");
  assert.deepEqual(retries, [{ method: "GET", path: "/api/2.0/sql/statements/:id", attempt: 0, delayMs: 500, status: 503 }]);
  assert.deepEqual(requests, [{ method: "GET", path: "/api/2.0/sql/statements/:id", status: 200, ms: 120 }]);
});

test("onRetry reports network errors without a status", async () => {
  const retries: RetryEvent[] = [];
  const stub = stubFetch([new TypeError("fetch failed"), Response.json({ ok: true })]);
  const api = createClient(auth, { fetch: stub.fetch, sleep: async () => {}, onRetry: (event) => retries.push(event) });
  await api.get("/x");
  assert.deepEqual(retries, [{ method: "GET", path: "/x", attempt: 0, delayMs: 500, error: "fetch failed" }]);
});

test("onRequest reports error statuses that are not retried", async () => {
  const requests: RequestEvent[] = [];
  const stub = stubFetch([Response.json({ error_code: "PERMISSION_DENIED" }, { status: 403 })]);
  const api = createClient(auth, { fetch: stub.fetch, sleep: async () => {}, onRequest: (event) => requests.push(event) });
  await assert.rejects(api.post("/x", {}), DatabricksApiError);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.status, 403);
  assert.equal(requests[0]!.method, "POST");
});

test("redactPath replaces ids and table names and drops the query string", () => {
  assert.equal(redactPath("/api/2.0/sql/statements/01f0abcd-1234/result/chunks/3?x=1"), "/api/2.0/sql/statements/:id/result/chunks/3");
  assert.equal(redactPath("/api/2.1/unity-catalog/tables/main.sales.orders"), "/api/2.1/unity-catalog/tables/:id");
  assert.equal(redactPath("/api/2.0/sql/warehouses"), "/api/2.0/sql/warehouses");
});

function timeoutError() {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

test("a timeout while reading a success body follows the fetch timeout rules", async () => {
  const stalled = () => Object.assign(new Response("{}"), { json: async () => { throw timeoutError(); } });
  const get = client([stalled(), Response.json({ ok: 1 })]);
  assert.deepEqual(await get.api.get("/x"), { ok: 1 });
  assert.equal(get.calls.length, 2);

  const post = client([stalled()]);
  await assert.rejects(post.api.post("/api/2.0/sql/statements", {}), (error: unknown) => error instanceof DakError && /timed out after 60 s/.test(error.message));
  assert.equal(post.calls.length, 1);
});

test("a timeout while reading an error body follows the fetch timeout rules", async () => {
  const stalled = () => Object.assign(new Response("{}", { status: 400 }), { text: async () => { throw timeoutError(); } });
  const get = client([stalled(), Response.json({ ok: 1 })]);
  assert.deepEqual(await get.api.get("/x"), { ok: 1 });

  const post = client([stalled()]);
  await assert.rejects(post.api.post("/x", {}), (error: unknown) => error instanceof DakError && /timed out/.test(error.message));
});

test("an unreadable success body is not retried", async () => {
  const { api, calls } = client([new Response("not json", { status: 200 })]);
  await assert.rejects(api.get("/x"), SyntaxError);
  assert.equal(calls.length, 1);
});

test("a throwing hook never breaks a request", async () => {
  const stub = stubFetch([new Response("{}", { status: 503 }), Response.json({ ok: true })]);
  const api = createClient(auth, {
    fetch: stub.fetch,
    sleep: async () => {},
    onRetry: () => { throw new Error("hook failed"); },
    onRequest: () => { throw new Error("hook failed"); },
  });
  assert.deepEqual(await api.get("/x"), { ok: true });
});
