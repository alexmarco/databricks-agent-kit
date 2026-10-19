import type { AuthProvider, FetchLike } from "./auth.ts";
import { DakError } from "./errors.ts";

/** Non-retryable error response from a Databricks REST API, with an actionable hint when one is known. */
export class DatabricksApiError extends DakError {
  /** HTTP status code. */
  readonly status: number;
  /** Databricks `error_code`, or `HTTP_<status>` when the body has none. */
  readonly errorCode: string;

  constructor(status: number, errorCode: string, message: string) {
    super("DATABRICKS_API", message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

/** Query string value; undefined values are skipped. */
export type QueryValue = string | number | boolean | undefined;

/** Authenticated JSON client for the workspace REST APIs. */
export interface DatabricksClient {
  readonly host: string;
  /** GETs a workspace path (retried on network errors, 429 and 503). */
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  /** POSTs a JSON body to a workspace path (retried on 429 and 503 only). */
  post<T>(path: string, body?: unknown): Promise<T>;
}

/** A request about to be retried; `path` is redacted. */
export interface RetryEvent {
  method: "GET" | "POST";
  path: string;
  /** Zero-based index of the attempt that failed. */
  attempt: number;
  delayMs: number;
  /** HTTP status of the failed attempt, absent for network errors and timeouts. */
  status?: number;
  /** Message of the network error or timeout, absent for HTTP statuses. */
  error?: string;
}

/** A request that got a final response, retries included in `ms`; `path` is redacted. */
export interface RequestEvent {
  method: "GET" | "POST";
  path: string;
  status: number;
  ms: number;
}

/** Network and timer dependencies, injected so tests control retries and backoff; the hooks are optional observers. */
export interface ClientDependencies {
  fetch: FetchLike;
  sleep(ms: number): Promise<void>;
  /** Clock used to time requests; defaults to `Date.now`. */
  now?(): number;
  onRetry?(event: RetryEvent): void;
  onRequest?(event: RequestEvent): void;
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 30_000;
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
    return new DatabricksApiError(
      status,
      `HTTP_${status}`,
      `HTTP ${status} from Databricks: ${bodyText.slice(0, 200)}`,
    );
  }
  const errorCode = payload.error_code;
  const hint = HINTS[errorCode] ?? (status === 401 ? HINTS.UNAUTHENTICATED : undefined);
  const message = [`[${errorCode}] ${payload.message ?? "No message"}`, hint].filter(Boolean).join(" ");
  return new DatabricksApiError(status, errorCode, message);
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS)
    : BASE_BACKOFF_MS * 2 ** attempt;
}

/**
 * Drops the query string and replaces the segments that identify objects with `:id`: table full names
 * (a letter and a dot) and statement ids (8 or more characters with a digit). Safe to log.
 */
export function redactPath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery
    .split("/")
    .map((segment) =>
      (/[a-z]/i.test(segment) && segment.includes(".")) || (segment.length >= 8 && /\d/.test(segment))
        ? ":id"
        : segment,
    )
    .join("/");
}

/** Runs an observability hook; a failing hook must never break a request. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Ignored on purpose.
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * Creates a client that sends the bearer token only to `auth.host`.
 * @throws {DatabricksApiError} From its methods, for error responses once retries are exhausted.
 * @throws {DakError} From its methods, when a request times out (GET only after retries are exhausted).
 */
export function createClient(auth: AuthProvider, deps: ClientDependencies): DatabricksClient {
  async function request<T>(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, QueryValue>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, auth.host);
    if (url.origin !== new URL(auth.host).origin) {
      throw new DakError(
        "DATABRICKS_API",
        `Refusing to send credentials to ${url.origin}; only ${auth.host} is allowed.`,
      );
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const loggedPath = redactPath(url.pathname);
    const now = deps.now ?? Date.now;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${await auth.getToken()}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      let payload: unknown;
      let errorBody = "";
      const startedAt = now();
      try {
        response = await deps.fetch(url.toString(), {
          method,
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
          const delayMs = retryDelay(response, attempt);
          notify(() => deps.onRetry?.({ method, path: loggedPath, attempt, delayMs, status: response.status }));
          await deps.sleep(delayMs);
          continue;
        }
        // The timeout signal also covers the body, so a stalled body read is handled like a stalled fetch.
        if (response.ok) payload = await response.json();
        else errorBody = await response.text();
      } catch (error) {
        // A body that is not valid JSON is a server defect, not a transient failure.
        if (error instanceof SyntaxError) throw error;
        if (method === "GET" && attempt < MAX_RETRIES) {
          const delayMs = BASE_BACKOFF_MS * 2 ** attempt;
          notify(() =>
            deps.onRetry?.({
              method,
              path: loggedPath,
              attempt,
              delayMs,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          await deps.sleep(delayMs);
          continue;
        }
        if (isTimeout(error)) {
          throw new DakError(
            "DATABRICKS_API",
            `Request to ${loggedPath} timed out after ${REQUEST_TIMEOUT_MS / 1000} s`,
            { cause: error },
          );
        }
        throw error;
      }
      notify(() => deps.onRequest?.({ method, path: loggedPath, status: response.status, ms: now() - startedAt }));
      if (response.ok) return payload as T;
      throw errorFromResponse(response.status, errorBody);
    }
  }

  return {
    host: auth.host,
    get: (path, query) => request("GET", path, query),
    post: (path, body) => request("POST", path, undefined, body ?? {}),
  };
}
