import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { hashApiKey } from "../src/api-keys/keys.js";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { apiKeys, users } from "../src/db/schema.js";

const jwtSecret = "portal-keys-test-secret-at-least-32-bytes";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_portal_keys_test";
const connection = createDatabase(url.href);
const { db } = connection;
let server: Server;
let origin: string;
let token: string;
let foreignToken: string;
let ownerId: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_portal_keys_test`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
  server = createApp({ db, jwtSecret }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE api_keys, users CASCADE`);
  const [owner, foreign] = await db
    .insert(users)
    .values([
      { username: "owner", passwordHash: "unused-test-hash" },
      { username: "foreign", passwordHash: "unused-test-hash" },
    ])
    .returning();
  ownerId = owner.id;
  token = await signToken(owner.id, jwtSecret);
  foreignToken = await signToken(foreign.id, jwtSecret);
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

async function call(path = "/keys", options: RequestInit = {}, bearer = token) {
  const response = await fetch(`${origin}/api/portal${path}`, {
    ...options,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...options.headers },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}
async function create(scopes: string[] = ["search:read"]) {
  const response = await call("/keys", { method: "POST", body: JSON.stringify({ scopes }) });
  expect(response.status).toBe(201);
  return response.json();
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String),
      next_action: expect.any(String),
      retryable: status === 500,
      details: expect.any(Array),
    },
  });
  for (const detail of body.error.details)
    expect(Object.keys(detail).sort()).toEqual(["allowed_values", "parameter", "reason", "suggestion"]);
  return body;
}

it("reveals only on creation, persists only hashes and returns canonical allowlisted metadata", async () => {
  for (const scopes of [["search:read"], ["keys:manage"], ["keys:manage", "search:read"]]) {
    const result = await create(scopes);
    expect(Object.keys(result).sort()).toEqual(["data", "secret"]);
    expect(result.secret).toMatch(/^ghk_[A-Za-z0-9_-]{43}$/);
    expect(result.data).toEqual({
      id: expect.any(String),
      prefix: result.secret.slice(0, 12),
      scopes: scopes.length === 2 ? ["search:read", "keys:manage"] : scopes,
      created_at: expect.any(String),
      last_used_at: null,
      revoked_at: null,
    });
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, result.data.id));
    expect(stored.keyHash).toBe(hashApiKey(result.secret));
    expect(JSON.stringify(stored)).not.toContain(result.secret);
    const list = await (await call()).json();
    expect(list.data.find((key: { id: string }) => key.id === result.data.id)).toEqual(result.data);
    expect(JSON.stringify(list)).not.toContain(result.secret);
    expect(JSON.stringify(list)).not.toContain(stored.keyHash);
    // API keys are not portal JWTs, and JWTs cannot substitute for ad API keys.
    await expectError(await call("/keys", {}, result.secret), 401, "UNAUTHENTICATED");
  }
  const ad = await fetch(`${origin}/api/v1/niches`, { headers: { authorization: `Bearer ${token}` } });
  expect(ad.status).toBe(401);
});

it("isolates owners and permanently revokes, including repeated revocation", async () => {
  const { data } = await create();
  const foreignList = await (await call("/keys", {}, foreignToken)).json();
  expect(foreignList).toEqual({ data: [], limit: 20, offset: 0, has_more: false });
  const foreign = await expectError(
    await call(`/keys/${data.id}`, { method: "DELETE" }, foreignToken),
    404,
    "KEY_NOT_FOUND",
  );
  const missing = await expectError(
    await call("/keys/00000000-0000-0000-0000-000000000000", { method: "DELETE" }),
    404,
    "KEY_NOT_FOUND",
  );
  expect(foreign).toEqual(missing);
  const response = await call(`/keys/${data.id}`, { method: "DELETE" });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  const first = await (await call()).json();
  expect(first.data[0].revoked_at).toEqual(expect.any(String));
  expect((await call(`/keys/${data.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await (await call()).json()).toEqual(first);
});

it("paginates all owner metadata with stable tie ordering and no API-key admission", async () => {
  for (let index = 0; index < 3; index++) await create();
  await db.update(apiKeys).set({ createdAt: new Date("2026-01-01T00:00:00Z") });
  const all = await (await call()).json();
  expect(all.data.map((key: { id: string }) => key.id)).toEqual(all.data.map((key: { id: string }) => key.id).sort());
  const first = await (await call("/keys?limit=2&offset=0")).json();
  expect(first).toEqual({ data: all.data.slice(0, 2), limit: 2, offset: 0, has_more: true });
  expect(await (await call("/keys?limit=2&offset=2")).json()).toEqual({
    data: all.data.slice(2),
    limit: 2,
    offset: 2,
    has_more: false,
  });
  expect(await (await call("/keys?offset=99")).json()).toEqual({ data: [], limit: 20, offset: 99, has_more: false });
  // Even more than 60 JWT requests do not touch any key's allowance or last-used time.
  for (let index = 0; index < 61; index++) expect((await call()).status).toBe(200);
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.userId, ownerId));
  for (const row of rows) {
    expect(row.lastUsedAt).toBeNull();
    expect(row.rateAdmissions).toEqual([]);
  }
});

it.each([
  "{}",
  "null",
  "[]",
  "1",
  '"text"',
  '{"scopes":[]}',
  '{"scopes":"search:read"}',
  '{"scopes":["unknown"]}',
  '{"scopes":["search:read","search:read"]}',
  '{"scopes":["search:read"],"ownerId":"someone"}',
  '{"scopes":[null]}',
])("rejects invalid creation without creating a row: %s", async (body) => {
  await expectError(await call("/keys", { method: "POST", body }), 422, "VALIDATION_ERROR");
  expect((await db.select().from(apiKeys)).length).toBe(0);
});

it.each([
  "limit=0",
  "limit=101",
  "limit=-1",
  "limit=1.5",
  "limit=1e1",
  "limit=",
  "limit=1&limit=2",
  "offset=-1",
  "offset=9007199254740992",
  "offset=1.1",
  "offset=+1",
  "offset=",
  "offset[x]=1",
  "ownerId=other",
  "api_key=secret",
  "limit=2&extra=x",
])("rejects invalid/unknown query: %s", async (query) => {
  await expectError(await call(`/keys?${query}`), 422, "VALIDATION_ERROR");
});

it("rejects malformed/oversized JSON, invalid UUIDs and unknown routes locally", async () => {
  await expectError(await call("/keys", { method: "POST", body: "{" }), 400, "MALFORMED_JSON");
  await expectError(
    await call("/keys", { method: "POST", body: JSON.stringify({ scopes: ["x".repeat(17000)] }) }),
    413,
    "BODY_TOO_LARGE",
  );
  await expectError(
    await call("/keys", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }),
    422,
    "VALIDATION_ERROR",
  );
  for (const id of ["not-a-uuid", "123", "%ZZ"])
    await expectError(await call(`/keys/${id}`, { method: "DELETE" }), 422, "VALIDATION_ERROR");
  await expectError(
    await call("/keys?extra=x", { method: "POST", body: '{"scopes":["search:read"]}' }),
    422,
    "VALIDATION_ERROR",
  );
  await expectError(
    await call("/keys/00000000-0000-0000-0000-000000000000?extra=x", { method: "DELETE" }),
    422,
    "VALIDATION_ERROR",
  );
  await expectError(await call("/unknown"), 404, "NOT_FOUND");
  await expectError(await call("/keys", { method: "PATCH" }), 404, "NOT_FOUND");
});

it("maps unsupported and corrupt JSON representations to non-retryable client errors", async () => {
  for (const headers of [
    { "content-type": "application/json; charset=invalid" },
    { "content-encoding": "unsupported" },
    { "content-encoding": "gzip" },
  ]) {
    await expectError(await call("/keys", { method: "POST", body: "{}", headers }), 400, "MALFORMED_JSON");
  }
  const head = await call("/keys", { method: "HEAD" });
  expect(head.status).toBe(404);
  expect(await head.text()).toBe("");
});

it("uses live existing JWT verification, leaving old auth errors unchanged", async () => {
  for (const bearer of ["", "invalid", await signToken(ownerId, "different-secret")]) {
    await expectError(await call("/keys", {}, bearer), 401, "UNAUTHENTICATED");
  }
  const missing = await fetch(`${origin}/api/portal/keys`);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  await expectError(missing, 401, "UNAUTHENTICATED");
  await db.delete(users).where(eq(users.id, ownerId));
  await expectError(await call(), 401, "UNAUTHENTICATED");
  const oldAuth = await fetch(`${origin}/api/auth/me`);
  expect(oldAuth.status).toBe(401);
  expect(await oldAuth.json()).not.toHaveProperty("error.next_action");
});
