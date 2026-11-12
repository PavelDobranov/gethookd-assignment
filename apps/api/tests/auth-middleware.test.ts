import { once } from "node:events";
import type { Server } from "node:http";
import express, { type Response } from "express";
import { afterEach, expect, it, vi } from "vitest";

import { type AuthenticatedLocals, createRequireAuthentication } from "../src/auth/middleware.js";

let server: Server | undefined;

const user = { id: "user-id", username: "demo" };
const getUser = vi.fn<(token: string) => Promise<typeof user | null>>();
const protectedHandler = vi.fn();
const errorHandler = vi.fn();

async function listen() {
  const app = express();
  const requireAuthentication = createRequireAuthentication({ getUser });

  app.get("/public", (_req, res) => {
    res.json({ public: true });
  });
  app.get("/protected", requireAuthentication, (_req, res: Response<unknown, AuthenticatedLocals>) => {
    protectedHandler();
    res.json({ user: res.locals.user });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    errorHandler(error);
    res.sendStatus(503);
  });

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP listener");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
  vi.resetAllMocks();
});

it("rejects missing or malformed bearer headers without looking up a user or running the handler", async () => {
  const origin = await listen();
  for (const authorization of [undefined, "Basic abc", "Bearer", "Bearer  abc", "Bearer abc extra"]) {
    const response = await fetch(`${origin}/protected`, {
      headers: authorization ? { authorization } : {},
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
  }
  expect(getUser).not.toHaveBeenCalled();
  expect(protectedHandler).not.toHaveBeenCalled();
});

it("rejects an unresolved user without running the handler", async () => {
  getUser.mockResolvedValue(null);
  const origin = await listen();
  const response = await fetch(`${origin}/protected`, {
    headers: { authorization: "Bearer invalid" },
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { code: "UNAUTHENTICATED", message: "Authentication required." },
  });
  expect(getUser).toHaveBeenCalledExactlyOnceWith("invalid");
  expect(protectedHandler).not.toHaveBeenCalled();
});

it("looks up the user on each request and exposes it through locals before running the handler", async () => {
  getUser.mockResolvedValueOnce(user).mockResolvedValueOnce({ ...user, username: "renamed" });
  const origin = await listen();
  for (const username of ["demo", "renamed"]) {
    const response = await fetch(`${origin}/protected`, {
      headers: { authorization: "bEaReR valid-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { ...user, username } });
  }
  expect(getUser.mock.calls).toEqual([["valid-token"], ["valid-token"]]);
  expect(protectedHandler).toHaveBeenCalledTimes(2);

  const anonymous = await fetch(`${origin}/protected`);
  expect(anonymous.status).toBe(401);
  await anonymous.body?.cancel();
  expect(protectedHandler).toHaveBeenCalledTimes(2);
});

it("forwards service failures unchanged instead of treating them as unauthenticated", async () => {
  const failure = new Error("Database unavailable");
  getUser.mockRejectedValue(failure);
  const origin = await listen();
  const response = await fetch(`${origin}/protected`, {
    headers: { authorization: "Bearer valid-token" },
  });
  expect(response.status).toBe(503);
  await response.body?.cancel();
  expect(errorHandler).toHaveBeenCalledExactlyOnceWith(failure);
  expect(protectedHandler).not.toHaveBeenCalled();
});

it("leaves routes without authentication middleware public", async () => {
  const origin = await listen();
  const response = await fetch(`${origin}/public`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ public: true });
  expect(getUser).not.toHaveBeenCalled();
});
