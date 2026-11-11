import { DrizzleQueryError } from "drizzle-orm";
import type { ErrorRequestHandler } from "express";

function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof DrizzleQueryError) || !error.cause) return false;

  const cause: NodeJS.ErrnoException = error.cause;
  const { code } = cause;
  // pg's connection termination and client timeout errors have no code.
  return (
    code === undefined ||
    code.startsWith("08") ||
    code.startsWith("53") ||
    code.startsWith("57P0") ||
    [
      "57014",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(code)
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
