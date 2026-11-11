import { DrizzleQueryError } from "drizzle-orm";
import type { ErrorRequestHandler } from "express";

function hasUnavailableCode(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;

  const { code } = error;
  return (
    typeof code === "string" &&
    (code.startsWith("08") ||
      code.startsWith("53") ||
      [
        "57P01",
        "57P02",
        "57P03",
        "57P04",
        "57P05",
        "57014",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ENOTFOUND",
        "EAI_AGAIN",
      ].includes(code))
  );
}

function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof DrizzleQueryError)) return false;

  const { cause } = error;
  // Node may aggregate failed connection attempts to multiple addresses.
  return (
    hasUnavailableCode(cause) ||
    (cause instanceof AggregateError && cause.errors.some(hasUnavailableCode))
  );
}

export const handleAuthError: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  if (
    error instanceof Error &&
    "type" in error &&
    [
      "entity.parse.failed",
      "entity.too.large",
      "encoding.unsupported",
      "charset.unsupported",
      "request.aborted",
      "request.size.invalid",
    ].includes(String(error.type))
  ) {
    res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "Invalid JSON request." },
    });
    return;
  }

  if (databaseUnavailable(error)) {
    console.error("Authentication database unavailable.");
    res.status(503).json({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Authentication service unavailable.",
      },
    });
    return;
  }

  console.error("Unexpected authentication failure.");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error." },
  });
};
