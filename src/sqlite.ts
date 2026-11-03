import type { DatabaseSync } from "node:sqlite";

/** Loads node:sqlite without its one-time ExperimentalWarning (stderr noise for MCP clients). */
export async function loadDatabaseSync(): Promise<typeof DatabaseSync> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filtered(this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite")) return;
    return (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
