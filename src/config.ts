import { join } from "node:path";
import { ConfigError } from "./errors.ts";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type Transport = "stdio" | "http";
export type Environment = Readonly<Record<string, string | undefined>>;

export interface CliFlags {
  profile?: string | undefined;
  "allow-writes"?: boolean | undefined;
  transport?: string | undefined;
  host?: string | undefined;
  port?: string | undefined;
}

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
  logLevel: LogLevel;
}

export type DatabricksProfiles = Map<string, Record<string, string>>;

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

function parseTransport(value: string): Transport {
  if (value === "stdio" || value === "http") return value;
  throw new ConfigError(`Unsupported transport '${value}'. Use 'stdio' or 'http'.`);
}

function parseLogLevel(value: string): LogLevel {
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new ConfigError(`DAK_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got '${value}'.`);
}

const isTrue = (value: string | undefined): boolean => value === "true" || value === "1";

export function resolveSettings(flags: CliFlags, env: Environment, installDir: string): Settings {
  const portValue = flags.port ?? env.DAK_HTTP_PORT;
  return {
    profile: flags.profile ?? env.DATABRICKS_CONFIG_PROFILE ?? "DEFAULT",
    explicitProfile: flags.profile !== undefined,
    warehouseId: env.DATABRICKS_WAREHOUSE_ID,
    allowWrites: flags["allow-writes"] === true || isTrue(env.DAK_ALLOW_WRITES),
    maxRows: env.DAK_MAX_ROWS === undefined ? 1000 : parsePositiveInteger(env.DAK_MAX_ROWS, "DAK_MAX_ROWS"),
    transport: parseTransport(flags.transport ?? "stdio"),
    httpHost: flags.host ?? env.DAK_HTTP_HOST ?? "127.0.0.1",
    httpPort: portValue === undefined ? 8765 : parsePositiveInteger(portValue, "HTTP port"),
    httpToken: env.DAK_HTTP_TOKEN,
    storageDir: env.DAK_STORAGE_DIR ?? join(installDir, ".storage"),
    logLevel: env.DAK_LOG_LEVEL === undefined ? "info" : parseLogLevel(env.DAK_LOG_LEVEL),
  };
}
