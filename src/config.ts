import { join } from "node:path";
import { ConfigError } from "./errors.ts";

/** Log levels from most to least verbose; `DAK_LOG_LEVEL` drops entries below the chosen one. */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
/** One of {@link LOG_LEVELS}. */
export type LogLevel = (typeof LOG_LEVELS)[number];
/** MCP transport: one process per agent session (`stdio`) or one shared server (`http`). */
export type Transport = "stdio" | "http";
/** Read-only view of environment variables, such as `process.env`. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** Options parsed from the command line; they take precedence over environment variables. */
export interface CliFlags {
  profile?: string | undefined;
  allowWrites?: boolean | undefined;
  transport?: Transport | undefined;
  host?: string | undefined;
  port?: string | undefined;
}

/** Effective configuration after combining flags, environment variables and defaults. */
export interface Settings {
  profile: string;
  explicitProfile: boolean;
  warehouseId: string | undefined;
  allowWrites: boolean;
  maxRows: number;
  transport: Transport;
  httpHost: string;
  httpPort: number;
  httpToken: string | undefined;
  storageDir: string;
  exportDir: string;
  exportMaxBytes: number;
  logLevel: LogLevel;
}

/** Profiles of a Databricks config file: section name to its keys and values. */
export type DatabricksProfiles = Map<string, Record<string, string>>;

/** Parses the INI format of `~/.databrickscfg`; `;` and `#` comments and keys outside a section are ignored. */
export function parseDatabricksConfig(text: string): DatabricksProfiles {
  const profiles: DatabricksProfiles = new Map();
  let current: Record<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      current = {};
      profiles.set(section[1]!.trim(), current);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1 || current === undefined) continue;
    current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return profiles;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got '${value}'.`);
  }
  return parsed;
}

function parseLogLevel(value: string): LogLevel {
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new ConfigError(`DAK_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got '${value}'.`);
}

const isTrue = (value: string | undefined): boolean => value === "true" || value === "1";

/** Per-user state directory, so the logs (SQL text included) are not shared through the install directory. */
export function defaultStorageDir(env: Environment, platform: NodeJS.Platform, home: string): string {
  const base =
    platform === "win32"
      ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
      : (env.XDG_STATE_HOME ?? join(home, ".local", "state"));
  return join(base, "databricks-agent-kit");
}

/**
 * Combines flags, environment variables and defaults into the effective settings.
 * @param defaultStorage - Log directory used when `DAK_STORAGE_DIR` is not set, see {@link defaultStorageDir}.
 * @throws {ConfigError} When a numeric or log-level value is invalid.
 */
export function resolveSettings(flags: CliFlags, env: Environment, defaultStorage: string): Settings {
  const portValue = flags.port ?? env.DAK_HTTP_PORT;
  const storageDir = env.DAK_STORAGE_DIR ?? defaultStorage;
  return {
    profile: flags.profile ?? env.DATABRICKS_CONFIG_PROFILE ?? "DEFAULT",
    explicitProfile: flags.profile !== undefined,
    warehouseId: env.DATABRICKS_WAREHOUSE_ID,
    allowWrites: flags.allowWrites === true || isTrue(env.DAK_ALLOW_WRITES),
    maxRows: env.DAK_MAX_ROWS === undefined ? 1000 : parsePositiveInteger(env.DAK_MAX_ROWS, "DAK_MAX_ROWS"),
    transport: flags.transport ?? "stdio",
    httpHost: flags.host ?? env.DAK_HTTP_HOST ?? "127.0.0.1",
    httpPort: portValue === undefined ? 8765 : parsePositiveInteger(portValue, "HTTP port"),
    httpToken: env.DAK_HTTP_TOKEN,
    storageDir,
    exportDir: env.DAK_EXPORT_DIR ?? join(storageDir, "exports"),
    exportMaxBytes:
      env.DAK_EXPORT_MAX_BYTES === undefined
        ? 10 * 1024 ** 3
        : parsePositiveInteger(env.DAK_EXPORT_MAX_BYTES, "DAK_EXPORT_MAX_BYTES"),
    logLevel: env.DAK_LOG_LEVEL === undefined ? "info" : parseLogLevel(env.DAK_LOG_LEVEL),
  };
}
