/** Base class for the errors `dak` reports to the agent: their message is shown as is, without a stack trace. */
export class DakError extends Error {
  /** Stable machine-readable category, for example `AUTH` or `READ_ONLY`. */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid command-line flag or environment variable. */
export class ConfigError extends DakError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIG", message, options);
  }
}

/** Missing, unsupported or rejected Databricks credentials. */
export class AuthError extends DakError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTH", message, options);
  }
}

/** Feature the workspace does not offer (edition, admin setting or missing system tables). */
export class UnsupportedError extends DakError {
  constructor(message: string, options?: ErrorOptions) {
    super("UNSUPPORTED", message, options);
  }
}

/** Tool argument that cannot be used, such as a malformed table name. */
export class InvalidArgumentError extends DakError {
  constructor(message: string) {
    super("INVALID_ARGUMENT", message);
  }
}

/** `message` without anything that looks like a URL, plain or percent-encoded: result links are presigned. */
export function messageWithoutUrls(message: string): string {
  return message.replace(/https?(?::|%3A)(?:\/\/|%2F%2F)\S*/gi, "<url>");
}
