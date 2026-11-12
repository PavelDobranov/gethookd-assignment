import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { SignJWT, UnsecuredJWT } from "jose";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { users } from "../src/db/schema.js";

const secret = "identity-test-only-signing-secret-at-least-32-bytes";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_identity_test";
const connection = createDatabase(url.href);
const listeners: Server[] = [];
const extras: ReturnType<typeof createDatabase>[] = [];
let origin: string;
let id: string;
let token: string;

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
    await admin.db.execute(sql`CREATE DATABASE gethookd_identity_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  const [demo] = await connection.db.select().from(users).where(eq(users.username, "demo"));
  id = demo.id;
  const login = await fetch(`${await listen()}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "demo", password: "demo-password" }),
  });
  expect(login.status).toBe(200);
  token = (await login.json()).token;
  origin = await listen();
});

afterAll(async () => {
  vi.useRealTimers();
  for (const server of listeners) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await connection.close();
  for (const extra of extras) await extra.close();
});

async function unauthorized(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: { code: "UNAUTHENTICATED", message: "Authentication required." },
  });
}

it("resolves the database user on every request, ignores supplied claims and never caches identity", async () => {
  const claimed = await new SignJWT({
    username: "attacker",
    passwordHash: "private",
    role: "admin",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .sign(new TextEncoder().encode(secret));
  for (const username of ["renamed-demo", "demo"]) {
    await connection.db.update(users).set({ username }).where(eq(users.id, id));
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { authorization: `Bearer ${claimed}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ user: { id, username } });
  }
});

it("accepts login tokens after time advances and invalidates them when the signing secret changes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2100-01-01"));
  try {
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id, username: "demo" } });
  } finally {
    vi.useRealTimers();
  }
  const changed = await listen(connection.db, `${secret}-changed`);
  await unauthorized(
    await fetch(`${changed}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
});

it("rejects missing/malformed headers and never authenticates cookies or query parameters", async () => {
  for (const authorization of [undefined, "Basic abc", "Bearer", "Bearer abc", `Bearer ${token} extra`]) {
    await unauthorized(
      await fetch(`${origin}/api/auth/me?token=${token}&access_token=${token}`, {
        headers: {
          cookie: `token=${token}; access_token=${token}`,
          ...(authorization ? { authorization } : {}),
        },
      }),
    );
  }
});

it("rejects the token attack matrix and invalid subjects without leaking details", async () => {
  const key = new TextEncoder().encode(secret);
  const [header, payload, signature] = token.split(".");
  const attacks = [
    `${header}.${Buffer.from(JSON.stringify({ sub: randomUUID() })).toString("base64url")}.${signature}`,
    await signToken(id, `${secret}-wrong`),
    new UnsecuredJWT({ sub: id }).encode(),
    await new SignJWT({ sub: id }).setProtectedHeader({ alg: "HS384" }).sign(key),
    ...(await Promise.all(
      [undefined, null, "", 123, [], {}, "not-a-uuid", "' OR 1=1 --", randomUUID()].map((sub) =>
        new SignJWT(sub === undefined ? {} : { sub }).setProtectedHeader({ alg: "HS256" }).sign(key),
      ),
    )),
    `${header}.${payload}.broken`,
  ];
  for (const attack of attacks) {
    await unauthorized(
      await fetch(`${origin}/api/auth/me`, {
        headers: { authorization: `Bearer ${attack}` },
      }),
    );
  }
});

it("invalidates a valid token when its database subject is deleted", async () => {
  const [user] = await connection.db
    .insert(users)
    .values({ username: "temporary", passwordHash: "not-exposed" })
    .returning();
  const temporary = await signToken(user.id, secret);
  const response = await fetch(`${origin}/api/auth/me`, {
    headers: { authorization: `Bearer ${temporary}` },
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
  await connection.db.delete(users).where(eq(users.id, user.id));
  await unauthorized(
    await fetch(`${origin}/api/auth/me`, {
      headers: { authorization: `Bearer ${temporary}` },
    }),
  );
});

it("distinguishes a real unavailable database from invalid credentials and unexpected SQL failures", async () => {
  const unavailable = createDatabase("postgresql://private:private@127.0.0.1:1/private");
  extras.push(unavailable);
  const unavailableOrigin = await listen(unavailable.db);
  const response = await fetch(`${unavailableOrigin}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable.",
    },
  });
  await unauthorized(await fetch(`${unavailableOrigin}/api/auth/me`));
  await connection.db.execute(sql`ALTER TABLE users RENAME TO hidden_users`);
  try {
    const failed = await fetch(`${origin}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(failed.status).toBe(500);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(await failed.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    });
  } finally {
    await connection.db.execute(sql`ALTER TABLE hidden_users RENAME TO users`);
  }
});
