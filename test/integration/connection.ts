import type { AuthRequest } from "../../src/auth.ts";
import type { Environment } from "../../src/config.ts";

const ENVIRONMENT_VARIABLES = ["DATABRICKS_HOST", "DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"] as const;

/**
 * Chooses how the integration tests reach the workspace: the three environment variables when all are set (CI), otherwise
 * the named profile in DAK_IT_PROFILE (local runs).
 */
export function selectIntegrationConnection(env: Environment): AuthRequest {
  const environmentComplete = ENVIRONMENT_VARIABLES.every((name) => (env[name] ?? "") !== "");
  if (environmentComplete) {
    return {
      profile: "",
      explicitProfile: false,
      env: Object.fromEntries(ENVIRONMENT_VARIABLES.map((name) => [name, env[name]])),
    };
  }
  const profile = env.DAK_IT_PROFILE ?? "";
  if (profile === "") {
    const missing = ENVIRONMENT_VARIABLES.filter((name) => (env[name] ?? "") === "");
    throw new Error(
      `Missing ${missing.join(", ")}. Set DATABRICKS_HOST, DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET, or set DAK_IT_PROFILE to a named profile.`,
    );
  }
  return { profile, explicitProfile: true, env };
}
