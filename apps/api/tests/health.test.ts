import { once } from "node:events";
import type { Server } from "node:http";
import { createServer, type Socket } from "node:net";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { users } from "../src/db/schema.js";

const secret = "health-test-only-signing-secret-at-least-32-bytes";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_health_test";
const connection = createDatabase(url.href);
const servers: Server[] = [];
const extras: ReturnType<typeof createDatabase>[] = [];
let origin: string;
let token: string;

async function listen(db = connection.db) {
  const server = createApp({ db, jwtSecret: secret }).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_health_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  const [demo] = await connection.db.select().from(users);
  token = await signToken(demo.id, secret);
  origin = await listen();
});

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await connection.close();
  for (const extra of extras) await extra.close();
});

async function unavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." },
  });
}

it("reports public uncached PostgreSQL readiness without requiring credentials", async () => {
  const response = await fetch(`${origin}/api/health`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok" });
});

it("returns a generic 503 for an actual refused database connection", async () => {
  const refused = createDatabase(
    "postgresql://private:private@127.0.0.1:1/private",
  );
  extras.push(refused);
  await unavailable(await fetch(`${await listen(refused.db)}/api/health`));
});

it.each(["health", "login", "identity"])(
  "bounds %s connection waits when a TCP peer never completes PostgreSQL startup",
  async (route) => {
    const sockets = new Set<Socket>();
    const peer = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }).listen(0, "127.0.0.1");
    await once(peer, "listening");
    const address = peer.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP peer");
    const stalled = createDatabase(
      `postgresql://private:private@127.0.0.1:${address.port}/private`,
    );
    try {
      const stalledOrigin = await listen(stalled.db);
      const path =
        route === "health"
          ? "/api/health"
          : `/api/auth/${route === "login" ? "login" : "me"}`;
      const options =
        route === "login"
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                username: "demo",
                password: "demo-password",
              }),
            }
          : { headers: { authorization: `Bearer ${token}` } };
      const start = performance.now();
      await unavailable(await fetch(`${stalledOrigin}${path}`, options));
      expect(performance.now() - start).toBeLessThan(4000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await stalled.close();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  },
);

it("bounds protected query waits with real PostgreSQL locks and recovers after release", async () => {
  const locker = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 2000,
  });
  await locker.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE users IN ACCESS EXCLUSIVE MODE");
    const start = performance.now();
    const response = await fetch(`${origin}/api/auth/me`, {
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
    expect(performance.now() - start).toBeLessThan(4000);
  } finally {
    await locker.query("ROLLBACK");
    await locker.end();
  }
  const response = await fetch(`${origin}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
});
