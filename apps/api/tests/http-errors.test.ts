import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleErrors, sendError, sendQuotaExceeded, sendRateLimited } from "../src/shared/http-errors.js";

const cases = [
  ["INSUFFICIENT_SCOPE", 403],
  ["KEY_NOT_FOUND", 404],
  ["IDEMPOTENCY_CONFLICT", 409],
  ["MALFORMED_JSON", 400],
  ["BODY_TOO_LARGE", 413],
  ["VALIDATION_ERROR", 422],
] as const;
const reset = "2027-01-01T00:00:00.000Z";
let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  for (const [code] of cases) app.get(`/${code}`, (_req, res) => sendError(res, code));
  app.get("/quota", (_req, res) => sendQuotaExceeded(res, reset));
  app.get("/rate", (_req, res) => sendRateLimited(res, 17));
  app.get("/exception", () => {
    throw new Error("private SQL and credentials");
  });
  app.use(handleErrors);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("shared rich HTTP errors", () => {
  it.each(cases)("maps %s without extra envelope fields", async (code, status) => {
    const response = await fetch(`${origin}/${code}`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: { code, message: expect.any(String), next_action: expect.any(String), retryable: false, details: [] },
    });
  });

  it("includes the exact quota reset and matching rate wait", async () => {
    const quota = await fetch(`${origin}/quota`);
    expect(quota.status).toBe(403);
    expect(await quota.json()).toEqual({
      error: {
        code: "QUOTA_EXCEEDED",
        message: `The 1,000-call monthly quota is exhausted; it resets at ${reset}.`,
        next_action: expect.any(String),
        retryable: false,
        details: [{ parameter: "quota", reason: "monthly_quota_exceeded", allowed_values: [], suggestion: reset }],
      },
    });
    const rate = await fetch(`${origin}/rate`);
    expect(rate.status).toBe(429);
    expect(rate.headers.get("retry-after")).toBe("17");
    expect(await rate.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: expect.stringContaining("17"),
        next_action: expect.stringContaining("17"),
        retryable: true,
        details: [],
      },
    });
  });

  it("sanitizes exceptions without logging raw data", async () => {
    const log = vi.spyOn(console, "error");
    try {
      const response = await fetch(`${origin}/exception`);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        error: {
          code: "INTERNAL_ERROR",
          message: expect.any(String),
          next_action: expect.any(String),
          retryable: true,
          details: [],
        },
      });
      expect(JSON.stringify(body)).not.toContain("private");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
