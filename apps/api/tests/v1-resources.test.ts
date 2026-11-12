import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { niches } from "../src/ads/model.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { apiKeys, users } from "../src/db/schema.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_resources_test";
const connection = createDatabase(url.href);
const key = "public-v1-resource-test-key";
const jwtSecret = "public-v1-resource-jwt-secret-32-bytes";
let server: Server;
let origin: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v1_resources_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  const [demo] = await connection.db.select().from(users).where(eq(users.username, "demo"));
  await connection.db.insert(apiKeys).values({ userId: demo.id, keyHash: hashApiKey(key) });
  server = createApp({ db: connection.db, jwtSecret }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

function request(path = "/niches", authorization: string | null = `Bearer ${key}`) {
  return fetch(`${origin}/api/v1${path}`, {
    headers: authorization === null ? {} : { Authorization: authorization },
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error).toEqual({
    code,
    message: expect.any(String),
    next_action: expect.any(String),
    retryable: status === 500,
    details: expect.any(Array),
  });
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.next_action.length).toBeGreaterThan(0);
  return body.error;
}

it("returns exactly the existing ordered slug/name catalog and accepts the same key as v0", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ data: niches.map(({ slug, name }) => ({ slug, name })) });
  expect(niches).toHaveLength(12);
  const legacy = await fetch(`${origin}/api/v0/ads?api_key=${key}&per_page=1`);
  expect(legacy.status).toBe(200);
});

it.each([
  null,
  "",
  "Basic invalid",
  "Bearer",
  "Bearer ",
  "Bearer invalid",
  `Bearer ${key} extra`,
  `Bearer ${key},${key}`,
])("rejects missing, malformed or invalid credentials: %s", async (authorization) => {
  const error = await expectError(await request("/niches", authorization), 401, "UNAUTHENTICATED");
  expect(error.details).toEqual([]);
  expect(error.next_action).toContain("Bearer");
});

it("rejects query-key-only and portal JWT substitution", async () => {
  await expectError(await request(`/niches?api_key=${key}`, null), 401, "UNAUTHENTICATED");
  const jwt = await new SignJWT({ sub: "1" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
  await expectError(await request("/niches", `Bearer ${jwt}`), 401, "UNAUTHENTICATED");
});

it("consults stored keys again on the very next request", async () => {
  expect((await request()).status).toBe(200);
  await connection.db
    .update(apiKeys)
    .set({ keyHash: hashApiKey(`${key}-changed`) })
    .where(eq(apiKeys.keyHash, hashApiKey(key)));
  try {
    await expectError(await request(), 401, "UNAUTHENTICATED");
    expect((await request("/niches", `Bearer ${key}-changed`)).status).toBe(200);
  } finally {
    await connection.db
      .update(apiKeys)
      .set({ keyHash: hashApiKey(key) })
      .where(eq(apiKeys.keyHash, hashApiKey(`${key}-changed`)));
  }
});
