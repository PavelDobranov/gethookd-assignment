import type { ErrorRequestHandler, Response } from "express";

import { MONTHLY_QUOTA } from "../limits.js";

export type ValidationDetail = {
  parameter: string;
  reason: string;
  allowed_values: string[];
  suggestion: string | null;
};

type ErrorDefinition = { status: number; message: string; next_action: string };

const errors = {
  UNAUTHENTICATED: {
    status: 401,
    message: "A valid Bearer session token is required.",
    next_action: "Log in and provide Authorization: Bearer <token>.",
  },
  INSUFFICIENT_SCOPE: {
    status: 403,
    message: "The credential lacks a required scope.",
    next_action: "Use a credential with the required scope; retries cannot grant permission.",
  },
  KEY_NOT_FOUND: {
    status: 404,
    message: "The requested key was not found.",
    next_action: "Use a key ID from your own key list.",
  },
  NOT_FOUND: {
    status: 404,
    message: "The requested route or method was not found.",
    next_action: "Use a documented route and method.",
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "This Idempotency-Key is already bound to a different request.",
    next_action: "Reuse it only for the original request, or use a new value for a new request.",
  },
  VALIDATION_ERROR: {
    status: 422,
    message: "The request contains invalid parameters.",
    next_action: "Correct the listed parameters using the documented request shape.",
  },
  MALFORMED_JSON: {
    status: 400,
    message: "The request body is not valid JSON.",
    next_action: "Send a correctly encoded JSON body.",
  },
  BODY_TOO_LARGE: {
    status: 413,
    message: "The request body exceeds 16 KB.",
    next_action: "Send a JSON body no larger than 16 KB.",
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "The request could not be completed.",
    next_action: "Retry after a short delay; do not retry in a tight loop.",
  },
} as const;

export function sendHttpError(
  res: Response,
  code: string,
  definition: ErrorDefinition,
  details: ValidationDetail[] = [],
) {
  res.status(definition.status).json({
    error: {
      code,
      message: definition.message,
      next_action: definition.next_action,
      retryable: definition.status === 500 || definition.status === 429,
      details,
    },
  });
}

export function sendError(res: Response, code: keyof typeof errors, details: ValidationDetail[] = []) {
  sendHttpError(res, code, errors[code], details);
}

export function sendQuotaExceeded(res: Response, resetAt: string) {
  sendHttpError(
    res,
    "QUOTA_EXCEEDED",
    {
      status: 403,
      message: `The ${MONTHLY_QUOTA.toLocaleString("en-US")}-call monthly quota is exhausted; it resets at ${resetAt}.`,
      next_action: "Wait for the reset; free operations and matching billed retries remain available.",
    },
    [{ parameter: "quota", reason: "monthly_quota_exceeded", allowed_values: [], suggestion: resetAt }],
  );
}

export function sendRateLimited(res: Response, retryAfter: number) {
  res.set("Retry-After", String(retryAfter));
  sendHttpError(res, "RATE_LIMITED", {
    status: 429,
    message: `The request allowance is exhausted. Wait ${retryAfter} seconds.`,
    next_action: `Retry after ${retryAfter} seconds; do not retry sooner.`,
  });
}

export const handleErrors: ErrorRequestHandler = (_error, _req, res, _next) => {
  // Exceptions can contain SQL, credentials and bodies. Never log or reflect them.
  sendError(res, "INTERNAL_ERROR");
};
