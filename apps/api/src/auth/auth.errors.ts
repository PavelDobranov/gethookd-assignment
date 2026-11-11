import { DrizzleQueryError } from "drizzle-orm";
import type { ErrorRequestHandler } from "express";

function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof DrizzleQueryError)) return false;
  const cause = error.cause;
  if (!(cause instanceof Error)) return false;

  // Inspect the driver's structured code once, not a chain of error messages.
  // pg's connection termination and client timeout errors have no code.
  if (!("code" in cause)) return true;
  if (typeof cause.code !== "string") return false;
  return (
    cause.code.startsWith("08") ||
    cause.code.startsWith("53") ||
    cause.code.startsWith("57P0") ||
    [
      "57014",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(cause.code)
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
    res.status(503).json({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Authentication service unavailable.",
      },
    });
    return;
  }
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error." },
  });
};
