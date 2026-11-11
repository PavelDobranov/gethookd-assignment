import { DrizzleQueryError } from "drizzle-orm";
import type { ErrorRequestHandler } from "express";

// Map request failures to
//  - 400 (invalid body)
//  - 503 (database unavailable)
//  - 500 (any other failure)
// without exposing internal error details
export const handleErrors: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  if (isInvalidRequestBody(error)) {
    res.status(400).json({
      error: { code: "INVALID_REQUEST", message: "Invalid JSON request." },
    });

    return;
  }

  if (isDatabaseUnavailable(error)) {
    console.error("Database unavailable.");

    res.status(503).json({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Service unavailable.",
      },
    });

    return;
  }

  console.error("Unexpected request failure.");

  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error." },
  });
};

function isInvalidRequestBody(error: unknown): boolean {
  return (
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
  );
}

function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof DrizzleQueryError)) return false;

  const { cause } = error;

  // Node may aggregate failed connection attempts to multiple addresses.
  return (
    isDatabaseUnavailableCause(cause) ||
    (cause instanceof AggregateError &&
      cause.errors.some(isDatabaseUnavailableCause))
  );
}

function isDatabaseUnavailableCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // pg's client-side query_timeout emits this exact error without a code.
  // It can win the race with PostgreSQL's statement_timeout (57014).
  if (!("code" in error)) return error.message === "Query read timeout";

  const { code } = error;

  return (
    typeof code === "string" &&
    (code.startsWith("08") || // PostgreSQL connection exceptions
      code.startsWith("53") || // PostgreSQL insufficient resources
      [
        // PostgreSQL shutdown, recovery, and query cancellation
        "57P01",
        "57P02",
        "57P03",
        "57P04",
        "57P05",
        "57014",
        // Node.js network and DNS failures
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
