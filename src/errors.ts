export class DakError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigError extends DakError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIG", message, options);
  }
}

export class AuthError extends DakError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTH", message, options);
  }
}

export class UnsupportedError extends DakError {
  constructor(message: string, options?: ErrorOptions) {
    super("UNSUPPORTED", message, options);
  }
}

export class InvalidArgumentError extends DakError {
  constructor(message: string) {
    super("INVALID_ARGUMENT", message);
  }
}
