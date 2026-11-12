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
    message: "The request contains unsupported parameters or a malformed path.",
    next_action: "Remove unsupported query parameters and use a correctly URL-encoded path.",
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "The request could not be completed.",
    next_action: "Retry after a short delay; do not retry in a tight loop.",
  },
} as const;

export function sendV1Error(res: Response, code: keyof typeof errors, details: ValidationDetail[] = []) {
  const { status, message, next_action } = errors[code];
  res.status(status).json({ error: { code, message, next_action, retryable: status === 500, details } });
}

export const handleV1Errors: ErrorRequestHandler = (_error, _req, res, _next) => {
  // Raw exceptions can include SQL, credentials and cursor contents. Never log them.
  sendV1Error(res, "INTERNAL_ERROR");
};
