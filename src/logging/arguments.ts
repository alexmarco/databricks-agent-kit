const STATEMENT_LIMIT = 4096;

/**
 * Describes tool arguments for the log: a `statement` over 4096 characters is cut and states how many characters were
 * dropped, and `parameters` keep only `name` and `type` so their values are never logged. Other keys pass through.
 */
export function describeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const described = { ...args };
  if (typeof described.statement === "string" && described.statement.length > STATEMENT_LIMIT) {
    described.statement = `${described.statement.slice(0, STATEMENT_LIMIT)}…[+${described.statement.length - STATEMENT_LIMIT} chars]`;
  }
  if (Array.isArray(described.parameters)) {
    described.parameters = described.parameters.map((parameter: { name?: unknown; type?: unknown }) => ({ name: parameter.name, type: parameter.type }));
  }
  return described;
}
