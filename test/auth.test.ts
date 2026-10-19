import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAuth, type AuthDependencies } from "../src/auth.ts";
import { AuthError } from "../src/errors.ts";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function deps(
  overrides: Partial<AuthDependencies> & { config?: string } = {},
): AuthDependencies & { fetchCalls: FetchCall[]; cliCalls: string[][] } {
  const fetchCalls: FetchCall[] = [];
  const cliCalls: string[][] = [];
  const { config, ...rest } = overrides;
  return {
    readConfig: async () => config,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json({ access_token: "m2m-token", expires_in: 3600 });
    },
    runCli: async (args) => {
      cliCalls.push(args);
      return JSON.stringify({
        access_token: "u2m-token",
        token_type: "Bearer",
        expiry: new Date(Date.now() + 3600_000).toISOString(),
      });
    },
    now: () => Date.now(),
    fetchCalls,
    cliCalls,
    ...rest,
  };
}

const base = { profile: "DEFAULT", explicitProfile: false };

test("environment PAT wins when no explicit profile", async () => {
  const auth = await resolveAuth(
    { ...base, env: { DATABRICKS_HOST: "a.cloud.databricks.com/", DATABRICKS_TOKEN: "dapi1" } },
    deps({ config: "[DEFAULT]\nhost=https://b\ntoken=x\n" }),
  );
  assert.equal(auth.method, "pat");
  assert.equal(auth.host, "https://a.cloud.databricks.com");
  assert.equal(await auth.getToken(), "dapi1");
});

test("plain http hosts are rejected except on loopback", async () => {
  await assert.rejects(
    resolveAuth({ ...base, env: { DATABRICKS_HOST: "http://a.cloud.databricks.com", DATABRICKS_TOKEN: "t" } }, deps()),
    /must use https/,
  );
  const local = await resolveAuth(
    { ...base, env: { DATABRICKS_HOST: "http://127.0.0.1:8080", DATABRICKS_TOKEN: "t" } },
    deps(),
  );
  assert.equal(local.host, "http://127.0.0.1:8080");
});

test("environment M2M requests a client_credentials token and caches it", async () => {
  const d = deps();
  const auth = await resolveAuth(
    { ...base, env: { DATABRICKS_HOST: "https://a", DATABRICKS_CLIENT_ID: "id", DATABRICKS_CLIENT_SECRET: "sec" } },
    d,
  );
  assert.equal(auth.method, "oauth-m2m");
  assert.equal(await auth.getToken(), "m2m-token");
  assert.equal(await auth.getToken(), "m2m-token");
  assert.equal(d.fetchCalls.length, 1);
  const call = d.fetchCalls[0]!;
  assert.equal(call.url, "https://a/oidc/v1/token");
  assert.equal(call.init?.method, "POST");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from("id:sec").toString("base64")}`);
  assert.equal(String(call.init?.body), "grant_type=client_credentials&scope=all-apis");
});

test("M2M token is refreshed shortly before expiry", async () => {
  let clock = 1_000_000;
  const d = deps({ now: () => clock });
  const auth = await resolveAuth(
    { ...base, env: { DATABRICKS_HOST: "https://a", DATABRICKS_CLIENT_ID: "id", DATABRICKS_CLIENT_SECRET: "sec" } },
    d,
  );
  await auth.getToken();
  clock += 3600_000 - 30_000;
  await auth.getToken();
  assert.equal(d.fetchCalls.length, 2);
});

test("explicit profile ignores environment credentials", async () => {
  const auth = await resolveAuth(
    { profile: "dev", explicitProfile: true, env: { DATABRICKS_HOST: "https://env", DATABRICKS_TOKEN: "envtok" } },
    deps({ config: "[dev]\nhost = https://dev.example\ntoken = devtok\n" }),
  );
  assert.equal(auth.host, "https://dev.example");
  assert.equal(await auth.getToken(), "devtok");
});

test("profile with client credentials uses M2M", async () => {
  const auth = await resolveAuth(
    { ...base, env: {} },
    deps({ config: "[DEFAULT]\nhost=https://p\nclient_id=i\nclient_secret=s\n" }),
  );
  assert.equal(auth.method, "oauth-m2m");
});

test("profile with databricks-cli auth delegates to databricks auth token", async () => {
  const d = deps({ config: "[DEFAULT]\nhost=https://p\nauth_type=databricks-cli\n" });
  const auth = await resolveAuth({ ...base, env: {} }, d);
  assert.equal(auth.method, "oauth-u2m");
  assert.equal(await auth.getToken(), "u2m-token");
  assert.equal(await auth.getToken(), "u2m-token");
  assert.deepEqual(d.cliCalls, [["auth", "token", "--profile", "DEFAULT"]]);
});

test("profile warehouse_id is exposed", async () => {
  const auth = await resolveAuth(
    { ...base, env: {} },
    deps({ config: "[DEFAULT]\nhost=https://p\ntoken=t\nwarehouse_id=wh1\n" }),
  );
  assert.equal(auth.profileWarehouseId, "wh1");
});

test("missing credentials explain the manual steps", async () => {
  await assert.rejects(resolveAuth({ ...base, env: {} }, deps()), (error: unknown) => {
    assert.ok(error instanceof AuthError);
    assert.match(error.message, /databricks auth login/);
    return true;
  });
});

test("unknown profile lists the available ones", async () => {
  await assert.rejects(
    resolveAuth(
      { profile: "nope", explicitProfile: true, env: {} },
      deps({ config: "[DEFAULT]\nhost=h\ntoken=t\n[dev]\nhost=h\ntoken=t\n" }),
    ),
    /nope.*DEFAULT, dev/s,
  );
});

test("profile without supported credentials is rejected", async () => {
  await assert.rejects(
    resolveAuth({ ...base, env: {} }, deps({ config: "[DEFAULT]\nhost=h\nauth_type=azure-cli\n" })),
    /azure-cli/,
  );
  await assert.rejects(resolveAuth({ ...base, env: {} }, deps({ config: "[DEFAULT]\ntoken=t\n" })), /host/);
});

test("CLI failures become actionable AuthErrors without leaking output tokens", async () => {
  const notFound = Object.assign(new Error("spawn databricks ENOENT"), { code: "ENOENT" });
  const auth = await resolveAuth(
    { ...base, env: {} },
    deps({
      config: "[DEFAULT]\nhost=h\nauth_type=databricks-cli\n",
      runCli: async () => {
        throw notFound;
      },
    }),
  );
  await assert.rejects(auth.getToken(), /Databricks CLI not found/);
  const auth2 = await resolveAuth(
    { ...base, env: {} },
    deps({
      config: "[DEFAULT]\nhost=h\nauth_type=databricks-cli\n",
      runCli: async () => {
        throw Object.assign(new Error("exit 1"), { stderr: "cache: token expired" });
      },
    }),
  );
  await assert.rejects(auth2.getToken(), /databricks auth login --profile DEFAULT/);
});

test("M2M token endpoint failure is an AuthError without the secret", async () => {
  const d = deps({ fetch: async () => new Response("invalid_client", { status: 401 }) });
  const auth = await resolveAuth(
    {
      ...base,
      env: { DATABRICKS_HOST: "https://a", DATABRICKS_CLIENT_ID: "id", DATABRICKS_CLIENT_SECRET: "topsecret" },
    },
    d,
  );
  await assert.rejects(auth.getToken(), (error: unknown) => {
    assert.ok(error instanceof AuthError);
    assert.doesNotMatch(error.message, /topsecret/);
    assert.match(error.message, /401/);
    return true;
  });
});

test("onRefresh is called once per fetched M2M token and not on cache hits", async () => {
  const refreshed: string[] = [];
  const auth = await resolveAuth(
    { ...base, env: { DATABRICKS_HOST: "https://a", DATABRICKS_CLIENT_ID: "id", DATABRICKS_CLIENT_SECRET: "sec" } },
    deps({ onRefresh: (method) => refreshed.push(method) }),
  );
  await auth.getToken();
  await auth.getToken();
  assert.deepEqual(refreshed, ["oauth-m2m"]);
});

test("onRefresh is called once per fetched U2M token and not on cache hits", async () => {
  const refreshed: string[] = [];
  const auth = await resolveAuth(
    { ...base, env: {} },
    deps({
      config: "[DEFAULT]\nhost = https://dev.example\nauth_type = databricks-cli\n",
      onRefresh: (method) => refreshed.push(method),
    }),
  );
  await auth.getToken();
  await auth.getToken();
  assert.deepEqual(refreshed, ["oauth-u2m"]);
});

test("a throwing onRefresh hook never breaks token retrieval", async () => {
  const auth = await resolveAuth(
    { ...base, env: { DATABRICKS_HOST: "https://a", DATABRICKS_CLIENT_ID: "id", DATABRICKS_CLIENT_SECRET: "sec" } },
    deps({
      onRefresh: () => {
        throw new Error("hook failed");
      },
    }),
  );
  assert.equal(await auth.getToken(), "m2m-token");
});
