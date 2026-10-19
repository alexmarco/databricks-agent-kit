import { join } from "node:path";
import type { ExportFormat } from "./types.ts";

const MAX_NAME_LENGTH = 64;
/** Windows device names are reserved with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Turns an agent-supplied name into a safe file name: characters outside `[A-Za-z0-9._-]` become `_`
 * (so no path separator survives), leading dots are removed, Windows device names get a `_` prefix
 * and the result is cut at 64 characters. A missing or empty name gives `export`.
 */
export function sanitizeExportName(name: string | undefined): string {
  const cleaned = (name ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, MAX_NAME_LENGTH);
  const safe = cleaned === "" ? "export" : cleaned;
  return WINDOWS_DEVICE_NAME.test(safe) ? `_${safe}`.slice(0, MAX_NAME_LENGTH) : safe;
}

/**
 * Export id: sanitized name plus the full statement id, whose characters outside `[A-Za-z0-9._-]` also become `_`.
 * The whole id is kept because Databricks statement ids are time-ordered: their first characters are shared by
 * statements submitted minutes apart.
 */
export function exportId(name: string | undefined, statementId: string): string {
  return `${sanitizeExportName(name)}-${statementId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Output path of an export: a `.csv` file, a `.db` file or, for Parquet, a directory named after the id. */
export function exportPath(dir: string, id: string, format: ExportFormat): string {
  if (format === "csv") return join(dir, `${id}.csv`);
  if (format === "sqlite") return join(dir, `${id}.db`);
  return join(dir, id);
}
