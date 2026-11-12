import { once } from "node:events";
import type { Server } from "node:http";
import { DrizzleQueryError } from "drizzle-orm";
import express from "express";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { handleErrors } from "../src/shared/middleware/handle-errors.js";

let server: Server;
let origin: string;
let failure: unknown;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post("/", (_req, _res, next) => next(failure));
  app.use(handleErrors);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(() => vi.restoreAllMocks());
afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
);

function queryFailure(cause: Error) {
  return new DrizzleQueryError("SELECT private-query", ["private-parameter"], cause);
}

async function request() {
  return fetch(origin, { method: "POST" });
}

it.each([
  "08006",
  "08001",
  "53300",
  "53100",
  "53200",
  "53400",
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
])("returns a safe 503 for database failure %s", async (code) => {
  failure = queryFailure(Object.assign(new Error("private-connection-string"), { code }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable.",
    },
  });
  expect(log.mock.calls).toEqual([["Database unavailable."]]);
});

it.each([
  ["client query_timeout", new Error("Query read timeout")],
  ["client connectionTimeoutMillis", new Error("Connection terminated due to connection timeout")],
  ["server statement_timeout", Object.assign(new Error("private-query"), { code: "57014" })],
])("returns a safe 503 for %s", async (_path, cause) => {
  failure = queryFailure(cause);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable.",
    },
  });
  expect(log.mock.calls).toEqual([["Database unavailable."]]);
});

it("recognizes a code-less aggregate driver failure with explicit network errors", async () => {
  failure = queryFailure(new AggregateError([Object.assign(new Error("private-address"), { code: "ECONNREFUSED" })]));
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await request()).status).toBe(503);
});

it.each([
  new Error("private-password private-token"),
  queryFailure(new Error("Connection terminated unexpectedly")),
  new Error("Query read timeout"),
  new Error("Connection terminated due to connection timeout"),
  queryFailure(new Error("private-sql Connection terminated due to connection timeout")),
  queryFailure(
    Object.assign(new Error("Connection terminated due to connection timeout"), {
      code: "42P01",
    }),
  ),
  queryFailure(new Error("private-sql Query read timeout")),
  queryFailure(Object.assign(new Error("Query read timeout"), { code: "42P01" })),
  queryFailure(Object.assign(new Error("private-sql"), { code: "42P01" })),
  queryFailure(Object.assign(new Error("private-sql"), { code: "23505" })),
  queryFailure(Object.assign(new Error("private-sql"), { code: "57P09" })),
  queryFailure(new AggregateError([])),
  queryFailure(new AggregateError([new Error("unknown driver failure")])),
])("returns a safe logged 500 for an unclassified failure (%#)", async (error) => {
  failure = error;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await request();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
    },
  });
  expect(log.mock.calls).toEqual([["Unexpected request failure."]]);
});

it("does not log malformed JSON or expose its contents", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await fetch(origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"private-password":',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "INVALID_REQUEST",
      message: "Invalid JSON request.",
    },
  });
  expect(log).not.toHaveBeenCalled();
});
