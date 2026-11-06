/** Exit codes. Keep these in sync with the Exit codes section in README. */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  SESSION: 3,
  NETWORK: 4,
  BLOCKED: 5,
  PARSE: 6,
  UNCERTAIN: 7,
} as const;

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super("USAGE", message, ExitCode.USAGE);
  }
}

export class NotLoggedInError extends CliError {
  constructor() {
    super(
      "NOT_LOGGED_IN",
      "No saved session. Log in to WebClass in your browser, then register its cookies with `webclass login --stdin`.",
      ExitCode.SESSION,
    );
  }
}

export class SessionExpiredError extends CliError {
  constructor(details?: Record<string, unknown>) {
    super(
      "SESSION_EXPIRED",
      "Your session has expired. Log in again in your browser, then update its cookies with `webclass login --stdin`.",
      ExitCode.SESSION,
      details,
    );
  }
}

export class BlockedUrlError extends CliError {
  constructor(url: string, reason: string) {
    super("BLOCKED_URL", `Access blocked by the safety policy: ${url} (${reason})`, ExitCode.BLOCKED, {
      url,
      reason,
    });
  }
}

export class HttpError extends CliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("HTTP_ERROR", message, ExitCode.NETWORK, details);
  }
}

export class ParseError extends CliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("PARSE_ERROR", message, ExitCode.PARSE, details);
  }
}

/** Redact acs_ tokens in URLs for error messages and logs. */
export function redactUrl(url: string | URL): string {
  return String(url).replace(/(acs_=)[^&#\s"']*/gi, "$1***");
}

export class OperationUncertainError extends CliError {
  constructor() {
    super("OPERATION_UNCERTAIN", "Could not verify the operation result. It will not be retried automatically. Check the save or submission status in WebClass.", ExitCode.UNCERTAIN);
  }
}
