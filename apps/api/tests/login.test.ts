import { once } from "node:events";
import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { users } from "../src/db/schema.js";

const secret = "login-test-only-signing-secret-at-least-32-bytes";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_login_test";
const connection = createDatabase(url.href);
const listeners: Server[] = [];
const extraConnections: ReturnType<typeof createDatabase>[] = [];
let baseUrl: string;
let demoId: string;

async function listen(db = connection.db, jwtSecret = secret) {
  const server = createApp({ db, jwtSecret }).listen(0, "127.0.0.1");
  listeners.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_login_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  const [demo] = await connection.db.select({ id: users.id }).from(users).where(eq(users.username, "demo"));
  demoId = demo.id;
  baseUrl = await listen();
});

afterAll(async () => {
  for (const server of listeners) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await connection.close();
  for (const extra of extraConnections) await extra.close();
});

function login(body: unknown, origin = baseUrl) {
  return fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("authenticates the seeded user and returns only allowlisted fields and a permanent HS256 subject", async () => {
  const response = await login({ username: "demo", password: "demo-password" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["token", "user"]);
  expect(body.user).toEqual({ id: demoId, username: "demo" });
  expect(typeof body.token).toBe("string");
  const verified = await jwtVerify(body.token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    currentDate: new Date("2100-01-01"),
  });
  expect(verified.protectedHeader).toEqual({ alg: "HS256" });
  expect(verified.payload).toEqual({ sub: demoId });
  await expect(
    jwtVerify(body.token, new TextEncoder().encode("different-secret-at-least-32-bytes"), { algorithms: ["HS256"] }),
  ).rejects.toThrow();
});

it("returns the same uncached generic 401 for unknown, wrong-case, wrong-password and SQL-like credentials", async () => {
  for (const credentials of [
    { username: "unknown", password: "demo-password" },
    { username: "Demo", password: "demo-password" },
    { username: "demo ", password: "demo-password" },
    { username: "demo", password: "wrong-password" },
    { username: "demo", password: " demo-password " },
    { username: "demo' OR 1=1 --", password: "demo-password" },
  ]) {
    const response = await login(credentials);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid username or password.",
      },
    });
  }
});

it.each([
  null,
  [],
  true,
  12,
  "demo",
  {},
  { username: "demo" },
  { password: "demo-password" },
  { username: "", password: "demo-password" },
  { username: "demo", password: "" },
  { username: 1, password: "demo-password" },
  { username: ["demo"], password: "demo-password" },
  { username: "demo", password: { value: "demo-password" } },
  { username: "x".repeat(101), password: "demo-password" },
  { username: "demo", password: "x".repeat(1025) },
])("rejects invalid credential shape/length (%#) with a safe uncached 422", async (input) => {
  const response = await login(input);
  expect(response.status).toBe(422);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: {
      code: "VALIDATION_ERROR",
      message: "Username and password must be nonempty strings of at most 100 and 1024 characters.",
    },
  });
});

it.each(['{"password":"private-input",', " ", "x".repeat(17000)])(
  "rejects malformed/oversized JSON (%#) without reflecting input",
  async (body) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid JSON request." },
    });
  },
);

it.each(["gzip", "deflate", "br"])("rejects corrupt %s compression with a safe 400", async (encoding) => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": encoding,
    },
    body: "not-valid-compressed-private-input",
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: { code: "INVALID_REQUEST", message: "Invalid JSON request." },
  });
});

it("rejects compressed JSON explicitly instead of inflating login bodies", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: gzipSync(JSON.stringify({ username: "demo", password: "demo-password" })),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: "INVALID_REQUEST", message: "Invalid JSON request." },
  });
});

it("recovers safely after an idle PostgreSQL connection is terminated", async () => {
  const isolated = createDatabase(url.href);
  extraConnections.push(isolated);
  const origin = await listen(isolated.db);
  const initial = await login({ username: "demo", password: "demo-password" }, origin);
  expect(initial.status).toBe(200);
  await initial.body?.cancel();
  const backend = await isolated.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await connection.db.execute(sql`SELECT pg_terminate_backend(${backend.rows[0].pid})`);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Database idle connection lost."));
    const recovered = await login({ username: "demo", password: "demo-password" }, origin);
    expect(recovered.status).toBe(200);
    await recovered.body?.cancel();
    expect(log.mock.calls.every((args) => args.length === 1 && args[0] === "Database idle connection lost.")).toBe(
      true,
    );
  } finally {
    log.mockRestore();
  }
});

it("accepts inclusive length limits, ignores supplied claims, and preserves whitespace exactly", async () => {
  for (const [username, password] of [
    ["u".repeat(100), "p".repeat(1024)],
    [" padded ", " secret "],
  ]) {
    const [user] = await connection.db
      .insert(users)
      .values({ username, passwordHash: await hashPassword(password) })
      .returning({ id: users.id });
    const response = await login({
      username,
      password,
      sub: "attacker-id",
      role: "admin",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user).toEqual({ id: user.id, username });
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    expect(payload).toEqual({ sub: user.id });
  }
});

it("returns sanitized 503 on real database connection failure, not a bad-credentials response", async () => {
  const unavailable = createDatabase("postgresql://private-user:private-password@127.0.0.1:1/private-db");
  extraConnections.push(unavailable);
  const origin = await listen(unavailable.db);
  const response = await login({ username: "demo", password: "demo-password" }, origin);
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable.",
    },
  });
});

it("returns a sanitized 500 for unexpected SQL failures", async () => {
  await connection.db.execute(sql`ALTER TABLE users RENAME TO temporarily_unavailable_users`);
  try {
    const response = await login({
      username: "demo",
      password: "demo-password",
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    });
  } finally {
    await connection.db.execute(sql`ALTER TABLE temporarily_unavailable_users RENAME TO users`);
  }
});
