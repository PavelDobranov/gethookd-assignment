import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { apiKeys, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_controls_test";
const connection = createDatabase(url.href);
let server: Server;
let origin: string;
let credential: string;
let keyId: string;
let sequence = 0;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v1_controls_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  server = createApp({ db: connection.db, jwtSecret: "controls-jwt-secret" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}/api/v1`;
});
beforeEach(async () => {
  credential = `controls-${++sequence}`;
  const [owner] = await connection.db
    .insert(users)
    .values({ username: credential, passwordHash: "unused" })
    .returning();
  const [key] = await connection.db
    .insert(apiKeys)
    .values(apiKeyFixture(owner.id, hashApiKey(credential), credential))
    .returning();
  keyId = key.id;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});
function request(path: string, method = "GET", authorization = `Bearer ${credential}`) {
  return fetch(`${origin}${path}`, { method, headers: { Authorization: authorization } });
}
async function state() {
  const [key] = await connection.db.select().from(apiKeys).where(eq(apiKeys.id, keyId));
  return key;
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).error).toMatchObject({ code, retryable: status === 429 || status === 500 });
}
it("admits exactly once before unsupported routes, methods and malformed paths", async () => {
  await error(await request("/future-management"), 404, "NOT_FOUND");
  await error(await request("/ads", "POST"), 404, "NOT_FOUND");
  await error(await request("/ads/%ZZ"), 422, "VALIDATION_ERROR");
  expect((await state()).rateAdmissions).toHaveLength(3);
  expect((await state()).lastUsedAt).toBeInstanceOf(Date);
});
it("uses live scopes and revocation before validation without admitting invalid credentials", async () => {
  await connection.db
    .update(apiKeys)
    .set({ scopes: ["keys:manage"] })
    .where(eq(apiKeys.id, keyId));
  await error(await request("/ads?unknown=1"), 403, "INSUFFICIENT_SCOPE");
  await error(await request("/niches"), 403, "INSUFFICIENT_SCOPE");
  expect((await state()).rateAdmissions).toHaveLength(2);
  await connection.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
  const used = (await state()).lastUsedAt;
  await error(await request("/ads/%ZZ"), 401, "UNAUTHENTICATED");
  expect((await state()).lastUsedAt).toEqual(used);
  expect((await state()).rateAdmissions).toHaveLength(2);
});
it("rate denial precedes scope and validation and does not append an admission", async () => {
  await connection.db.execute(
    sql`UPDATE api_keys SET scopes = ARRAY['keys:manage'], rate_admissions = array_fill(clock_timestamp(), ARRAY[60]) WHERE id = ${keyId}::uuid`,
  );
  const response = await request("/ads/%ZZ");
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  await error(response, 429, "RATE_LIMITED");
  expect((await state()).rateAdmissions).toHaveLength(60);
  expect((await state()).lastUsedAt).toBeInstanceOf(Date);
});
it("rejects query credentials and JWT-shaped values without updating last-used", async () => {
  await error(await request(`/niches?api_key=${credential}`, "GET", ""), 401, "UNAUTHENTICATED");
  await error(await request("/niches", "GET", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.invalid"), 401, "UNAUTHENTICATED");
  expect((await state()).lastUsedAt).toBeNull();
});
