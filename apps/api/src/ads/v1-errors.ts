import type { ErrorRequestHandler, Response } from "express";

export type ValidationDetail = {
  parameter: string;
  reason: string;
  allowed_values: string[];
  suggestion: string | null;
};

const errors = {
  UNAUTHENTICATED: {
    status: 401,
    message: "A valid Bearer API key is required.",
    next_action: "Provide a stored API key in Authorization: Bearer <key>.",
  },
  AD_NOT_FOUND: {
    status: 404,
    message: "The requested ad was not found.",
    next_action: "Check the exact ad ID from search results.",
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested v1 route or method was not found.",
    next_action: "Use a documented v1 route and method, such as GET /api/v1/niches.",
  },
  VALIDATION_ERROR: {
    status: 422,
    message: "The request contains invalid parameters or a malformed path.",
    next_action:
      "Use the listed parameter names and allowed values; discover niche slugs at /api/v1/niches. Use a correctly URL-encoded path.",
  },
  INVALID_CURSOR: {
    status: 422,
    message: "The cursor is invalid or unsupported.",
    next_action: "Use an unmodified supported cursor or start a fresh search.",
  },
  CURSOR_EXPIRED: {
    status: 422,
    message: "The search cursor has expired.",
    next_action: "Start a fresh search; retrying the same cursor will not help.",
  },
  CURSOR_QUERY_MISMATCH: {
    status: 422,
    message: "Supplied filters or sort differ from the original search.",
    next_action: "Retain the original query or start a new search to change filters or sort.",
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "The request could not be completed.",
    next_action: "Retry after a short delay; do not retry in a tight loop.",
  },
} as const;

export function sendV1Error(res: Response, code: keyof typeof errors, details: ValidationDetail[] = []) {
  const definition = errors[code];
  const requiresBrand =
    code === "VALIDATION_ERROR" && details.some((detail) => detail.reason === "required_for_impressions");
  const message = requiresBrand ? "sort=impressions requires one brand_id." : definition.message;
  const next_action = requiresBrand
    ? "Add one brand_id, or use sort=newest for cross-brand search."
    : definition.next_action;
  res
    .status(definition.status)
    .json({ error: { code, message, next_action, retryable: definition.status === 500, details } });
}

export const handleV1Errors: ErrorRequestHandler = (_error, _req, res, _next) => {
  // Raw exceptions can include SQL, credentials and cursor contents. Never log them.
  sendV1Error(res, "INTERNAL_ERROR");
};
