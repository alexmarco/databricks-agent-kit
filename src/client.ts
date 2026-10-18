import type { AuthProvider, FetchLike } from "./auth.ts";
import { DakError } from "./errors.ts";

export class DatabricksApiError extends DakError {
  readonly status: number;
  readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super("DATABRICKS_API", message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface DatabricksClient {
  readonly host: string;
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface ClientDependencies {
  fetch: FetchLike;
  sleep(ms: number): Promise<void>;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const RETRYABLE_STATUS = new Set([429, 503]);

const HINTS: Record<string, string> = {
  PERMISSION_DENIED: "The identity lacks the required privilege on that object; ask an admin to GRANT it.",
  UNAUTHENTICATED: "Re-authenticate (`databricks auth login --profile <name>`) or renew the token.",
  FEATURE_DISABLED: "This feature is not available in this workspace (edition or admin setting).",
  RESOURCE_EXHAUSTED: "Rate limit or quota exhausted; retry later.",
  REQUEST_LIMIT_EXCEEDED: "Rate limit exceeded; retry later.",
};

function errorFromResponse(status: number, bodyText: string): DatabricksApiError {
  let payload: { error_code?: string; message?: string } | undefined;
  try {
    payload = JSON.parse(bodyText) as { error_code?: string; message?: string };
  } catch {
    payload = undefined;
  }
  if (payload?.error_code === undefined) {
    return new DatabricksApiError(status, `HTTP_${status}`, `HTTP ${status} from Databricks: ${bodyText.slice(0, 200)}`);
  }
  const errorCode = payload.error_code;
  const hint = HINTS[errorCode] ?? (status === 401 ? HINTS.UNAUTHENTICATED : undefined);
  const message = [`[${errorCode}] ${payload.message ?? "No message"}`, hint].filter(Boolean).join(" ");
  return new DatabricksApiError(status, errorCode, message);
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BASE_BACKOFF_MS * 2 ** attempt;
}

export function createClient(auth: AuthProvider, deps: ClientDependencies): DatabricksClient {
  async function request<T>(method: "GET" | "POST", path: string, query?: Record<string, QueryValue>, body?: unknown): Promise<T> {
    const url = new URL(path, auth.host);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${await auth.getToken()}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await deps.fetch(url.toString(), {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (method === "GET" && attempt < MAX_RETRIES) {
          await deps.sleep(BASE_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        throw error;
      }
      if (response.ok) return (await response.json()) as T;
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
        await deps.sleep(retryDelay(response, attempt));
        continue;
      }
      throw errorFromResponse(response.status, await response.text());
    }
  }

  return {
    host: auth.host,
    get: (path, query) => request("GET", path, query),
    post: (path, body) => request("POST", path, undefined, body ?? {}),
  };
}
