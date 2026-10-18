import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseDatabricksConfig, type Environment } from "./config.ts";
import { AuthError } from "./errors.ts";

export type AuthMethod = "pat" | "oauth-m2m" | "oauth-u2m";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AuthProvider {
  readonly host: string;
  readonly method: AuthMethod;
  readonly profileWarehouseId: string | undefined;
  getToken(): Promise<string>;
}

export interface AuthDependencies {
  readConfig(): Promise<string | undefined>;
  fetch: FetchLike;
  runCli(args: string[]): Promise<string>;
  now(): number;
}

export interface AuthRequest {
  profile: string;
  explicitProfile: boolean;
  env: Environment;
}

const REFRESH_MARGIN_MS = 60_000;
const LOGIN_HINT =
  "Run `databricks auth login --host <workspace-url> --profile <name>` and pass --profile <name>, " +
  "or set DATABRICKS_HOST with DATABRICKS_TOKEN (or DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET).";
const SUPPORTED_AUTH =
  "Supported: personal access token (token), OAuth M2M (client_id + client_secret), OAuth U2M (auth_type = databricks-cli).";

export function normalizeHost(host: string): string {
  const withScheme = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  return withScheme.replace(/\/+$/, "");
}

function cachedToken(now: () => number, fetchToken: () => Promise<{ token: string; expiresAt: number }>): () => Promise<string> {
  let cache: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cache === undefined || now() >= cache.expiresAt - REFRESH_MARGIN_MS) {
      cache = await fetchToken();
    }
    return cache.token;
  };
}

function patProvider(host: string, token: string, profileWarehouseId: string | undefined): AuthProvider {
  return { host, method: "pat", profileWarehouseId, getToken: async () => token };
}

function m2mProvider(host: string, clientId: string, clientSecret: string, profileWarehouseId: string | undefined, deps: AuthDependencies): AuthProvider {
  const getToken = cachedToken(deps.now, async () => {
    const response = await deps.fetch(`${host}/oidc/v1/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=all-apis",
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new AuthError(`OAuth M2M token request to ${host} failed with HTTP ${response.status}: ${body}. Check the service principal client ID and secret.`);
    }
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof payload.access_token !== "string") {
      throw new AuthError(`OAuth M2M token response from ${host} has no access_token.`);
    }
    return { token: payload.access_token, expiresAt: deps.now() + (payload.expires_in ?? 3600) * 1000 };
  });
  return { host, method: "oauth-m2m", profileWarehouseId, getToken };
}

function u2mProvider(host: string, profile: string, profileWarehouseId: string | undefined, deps: AuthDependencies): AuthProvider {
  const getToken = cachedToken(deps.now, async () => {
    let output: string;
    try {
      output = await deps.runCli(["auth", "token", "--profile", profile]);
    } catch (error) {
      const failure = error as { code?: string; stderr?: string; message?: string };
      if (failure.code === "ENOENT") {
        throw new AuthError(
          "Databricks CLI not found on PATH. Install it (https://docs.databricks.com/aws/en/dev-tools/cli/install) or use a personal access token.",
          { cause: error },
        );
      }
      const detail = (failure.stderr ?? failure.message ?? "").trim().split(/\r?\n/)[0]?.slice(0, 300) ?? "";
      throw new AuthError(
        `Could not get an OAuth token from the Databricks CLI for profile '${profile}': ${detail}. Run \`databricks auth login --profile ${profile}\`.`,
        { cause: error },
      );
    }
    let payload: { access_token?: string; expiry?: string };
    try {
      payload = JSON.parse(output) as { access_token?: string; expiry?: string };
    } catch (error) {
      throw new AuthError("The Databricks CLI returned an unreadable token response; upgrade the CLI.", { cause: error });
    }
    if (typeof payload.access_token !== "string") {
      throw new AuthError(`The Databricks CLI returned no access token for profile '${profile}'. Run \`databricks auth login --profile ${profile}\`.`);
    }
    const expiresAt = payload.expiry === undefined ? Number.NaN : Date.parse(payload.expiry);
    return { token: payload.access_token, expiresAt: Number.isNaN(expiresAt) ? deps.now() + 300_000 : expiresAt };
  });
  return { host, method: "oauth-u2m", profileWarehouseId, getToken };
}

function fromEnvironment(env: Environment, deps: AuthDependencies): AuthProvider | undefined {
  if (env.DATABRICKS_HOST === undefined) return undefined;
  const host = normalizeHost(env.DATABRICKS_HOST);
  if (env.DATABRICKS_TOKEN !== undefined) return patProvider(host, env.DATABRICKS_TOKEN, undefined);
  if (env.DATABRICKS_CLIENT_ID !== undefined && env.DATABRICKS_CLIENT_SECRET !== undefined) {
    return m2mProvider(host, env.DATABRICKS_CLIENT_ID, env.DATABRICKS_CLIENT_SECRET, undefined, deps);
  }
  return undefined;
}

export async function resolveAuth(request: AuthRequest, deps: AuthDependencies): Promise<AuthProvider> {
  if (!request.explicitProfile) {
    const provider = fromEnvironment(request.env, deps);
    if (provider !== undefined) return provider;
  }

  const configText = await deps.readConfig();
  if (configText === undefined) {
    throw new AuthError(`No Databricks credentials found (no environment credentials and no ~/.databrickscfg). ${LOGIN_HINT}`);
  }
  const profiles = parseDatabricksConfig(configText);
  const profile = profiles.get(request.profile);
  if (profile === undefined) {
    const available = [...profiles.keys()].join(", ") || "none";
    throw new AuthError(`Profile '${request.profile}' not found in ~/.databrickscfg. Available profiles: ${available}. ${LOGIN_HINT}`);
  }
  if (profile.host === undefined) {
    throw new AuthError(`Profile '${request.profile}' has no host. ${LOGIN_HINT}`);
  }

  const host = normalizeHost(profile.host);
  const warehouseId = profile.warehouse_id;
  if (profile.token !== undefined) return patProvider(host, profile.token, warehouseId);
  if (profile.client_id !== undefined && profile.client_secret !== undefined) {
    return m2mProvider(host, profile.client_id, profile.client_secret, warehouseId, deps);
  }
  if (profile.auth_type === "databricks-cli") return u2mProvider(host, request.profile, warehouseId, deps);

  const authType = profile.auth_type === undefined ? "no credentials" : `auth_type '${profile.auth_type}'`;
  throw new AuthError(`Profile '${request.profile}' uses ${authType}, which is not supported. ${SUPPORTED_AUTH}`);
}

const execFileAsync = promisify(execFile);

export function defaultAuthDependencies(env: Environment): AuthDependencies {
  const configPath = env.DATABRICKS_CONFIG_FILE ?? join(homedir(), ".databrickscfg");
  return {
    readConfig: async () => {
      try {
        return await readFile(configPath, "utf8");
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    fetch: (input, init) => fetch(input, init),
    runCli: async (args) => (await execFileAsync("databricks", args, { timeout: 60_000, windowsHide: true })).stdout,
    now: () => Date.now(),
  };
}
