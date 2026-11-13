import { once } from "node:events";
import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { apiKeys, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const jwtSecret = "key-management-jwt-secret";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_key_management_test";
const connection = createDatabase(url.href);
const { db } = connection;
let server: Server;
let origin: string;
let ownerId: string;
let token: string;
let foreignToken: string;
const both = "management-both";
const manager = "management-only";
const search = "search-only";
const foreign = "foreign-both";
let selfId: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_key_management_test`);
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
  const [owner, other] = await db
    .insert(users)
    .values([
      { username: "owner", passwordHash: "unused" },
      { username: "other", passwordHash: "unused" },
    ])
    .returning();
  ownerId = owner.id;
  token = await signToken(ownerId, jwtSecret);
  foreignToken = await signToken(other.id, jwtSecret);
  const rows = await db
    .insert(apiKeys)
    .values([
      apiKeyFixture(ownerId, hashApiKey(both), both),
      { ...apiKeyFixture(ownerId, hashApiKey(manager), manager), scopes: ["keys:manage"] },
      { ...apiKeyFixture(ownerId, hashApiKey(search), search), scopes: ["search:read"] },
      apiKeyFixture(other.id, hashApiKey(foreign), foreign),
    ])
    .returning();
  selfId = rows[0].id;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await connection.close();
});
async function call(path = "/keys", options: RequestInit = {}, key = both, namespace = "v1") {
  const response = await fetch(`${origin}/api/${namespace}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...options.headers },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({
    error: {
      code,
      message: expect.any(String),
      next_action: expect.any(String),
      retryable: status === 500,
      details: expect.any(Array),
    },
  });
}
function create(scopes: string[], key = both, headers = {}) {
  return call("/keys", { method: "POST", body: JSON.stringify({ scopes }), headers }, key);
}
async function admissions() {
  return (
    await db.execute<{ count: number }>(sql`SELECT cardinality(rate_admissions) AS count FROM api_keys
    WHERE id = ${selfId}::uuid`)
  ).rows[0].count;
}
it("requires management scope, permits subset delegation only, and never substitutes JWT authority", async () => {
  for (const path of ["/keys", "/usage"]) {
    await error(await call(path, {}, search), 403, "INSUFFICIENT_SCOPE");
    expect((await call(path, {}, manager)).status).toBe(200);
    await error(await call(path, {}, token), 401, "UNAUTHENTICATED");
  }
  await error(await create(["keys:manage"], search), 403, "INSUFFICIENT_SCOPE");
  await error(await create(["search:read"], manager), 403, "INSUFFICIENT_SCOPE");
  await error(await create(["search:read", "keys:manage"], manager), 403, "INSUFFICIENT_SCOPE");
  await error(await create(["unknown"], manager), 422, "VALIDATION_ERROR");
  expect((await create(["keys:manage"], manager)).status).toBe(201);
  for (const scopes of [["search:read"], ["keys:manage"], ["search:read", "keys:manage"]]) {
    const response = await create(scopes);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.scopes).toEqual(scopes);
    expect(body.secret).toMatch(/^ghk_[A-Za-z0-9_-]{43}$/);
    const list = await (await call()).json();
    expect(JSON.stringify(list)).not.toContain(body.secret);
    expect(JSON.stringify(list)).not.toContain(hashApiKey(body.secret));
  }
});
it("isolates owner lists and revoke targets, allows repeat revoke and self-revoke", async () => {
  const otherList = await (await call("/keys", {}, foreign)).json();
  const foreignId = otherList.data[0].id;
  const list = await (await call("/keys?limit=1&offset=0")).json();
  expect(list).toMatchObject({ limit: 1, offset: 0, has_more: true });
  const all = await (await call()).json();
  expect(all.data).toHaveLength(3);
  expect(all.data.some((key: { id: string }) => key.id === foreignId)).toBe(false);
  const missing = await call("/keys/00000000-0000-0000-0000-000000000000", { method: "DELETE" });
  const denied = await call(`/keys/${foreignId}`, { method: "DELETE" });
  expect(missing.status).toBe(404);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual(await missing.json());
  expect((await call(`/keys/${selfId}`, { method: "DELETE" }, manager)).status).toBe(204);
  expect((await call(`/keys/${selfId}`, { method: "DELETE" }, manager)).status).toBe(204);
  await error(await call(), 401, "UNAUTHENTICATED");
  const created = await (await create(["keys:manage"], manager)).json();
  const revoked = await call(`/keys/${created.data.id}`, { method: "DELETE" }, created.secret);
  expect(revoked.status).toBe(204);
  expect(await revoked.text()).toBe("");
  await error(await call("/usage", {}, created.secret), 401, "UNAUTHENTICATED");
});
it("both usage routes read settled mixed-version owner charges, preserve history and remain free at quota", async () => {
  const v0 = await fetch(`${origin}/api/v0/ads?api_key=${both}&q=absent`, { headers: { "Idempotency-Key": "mixed" } });
  expect(v0.status).toBe(200);
  expect((await call("/ads?q=absent", {}, search)).status).toBe(200);
  const api = await (await call("/usage")).json();
  expect(api.data).toEqual({
    period_start: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00.000Z$/),
    period_end: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00.000Z$/),
    billable_calls: 2,
    quota: 1000,
    remaining: 998,
  });
  expect(await (await call("/usage", {}, token, "portal")).json()).toEqual(api);
  expect((await (await call("/usage", {}, foreignToken, "portal")).json()).data.billable_calls).toBe(0);
  const before = await admissions();
  for (let i = 0; i < 3; i++) expect((await call("/usage", {}, token, "portal")).status).toBe(200);
  expect(await admissions()).toBe(before);
  await db.execute(sql`UPDATE monthly_usage SET count = 1000 WHERE owner_id = ${ownerId}::uuid`);
  expect((await create(["keys:manage"], both, { "Idempotency-Key": "bad value!" })).status).toBe(201);
  for (const path of ["/keys", "/usage"])
    expect((await call(path, { headers: { "Idempotency-Key": "bad value!" } })).status).toBe(200);
  expect((await call(`/keys/${selfId}`, { method: "DELETE" })).status).toBe(204);
  const usage = await (await call("/usage", {}, manager)).json();
  expect(usage.data).toMatchObject({ billable_calls: 1000, remaining: 0 });
  expect(await (await call("/usage", {}, token, "portal")).json()).toEqual(usage);
});
it("admits exactly once per management request, ignores free idempotency and does not promise retry-safe creation", async () => {
  const first = await (await create(["keys:manage"], both, { "Idempotency-Key": "same" })).json();
  const second = await (await create(["keys:manage"], both, { "Idempotency-Key": "same" })).json();
  expect(first.secret).not.toBe(second.secret);
  expect(first.data.id).not.toBe(second.data.id);
  expect(await admissions()).toBe(2);
  const { rows } = await db.execute(sql`SELECT * FROM billing_bindings`);
  expect(rows).toEqual([]);
  expect((await (await call("/usage")).json()).data.billable_calls).toBe(0);
  expect(await admissions()).toBe(3);
});
it("validates JSON, sizes, queries and paths with rich errors; unsupported methods do not collide", async () => {
  for (const body of ["null", "[]", "{}", '{"scopes":[]}', '{"scopes":["keys:manage"],"owner_id":"foreign"}']) {
    await error(await call("/keys", { method: "POST", body }), 422, "VALIDATION_ERROR");
  }
  await error(await call("/keys", { method: "POST", body: "{" }), 400, "MALFORMED_JSON");
  await error(
    await call("/keys", { method: "POST", body: JSON.stringify({ scopes: ["x".repeat(17000)] }) }),
    413,
    "BODY_TOO_LARGE",
  );
  for (const path of [
    "/keys?limit=0",
    "/keys?limit=1&limit=2",
    "/keys?offset=-1",
    "/usage?owner_id=foreign",
    "/keys?unknown=yes",
  ]) {
    await error(await call(path), 422, "VALIDATION_ERROR");
  }
  await error(await call("/keys/not-a-uuid", { method: "DELETE" }), 422, "VALIDATION_ERROR");
  for (const [path, method] of [
    ["/keys", "PUT"],
    ["/keys", "OPTIONS"],
    ["/usage", "POST"],
    ["/unknown", "GET"],
  ]) {
    await error(await call(path, { method }), 404, "NOT_FOUND");
  }
  for (const path of ["/keys", "/usage"]) {
    const head = await call(path, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  }
});
it("usage storage errors are server failures, never authoritative zero", async () => {
  await db.execute(sql`ALTER TABLE monthly_usage RENAME TO monthly_usage_unavailable`);
  try {
    await error(await call("/usage"), 500, "INTERNAL_ERROR");
    await error(await call("/usage", {}, token, "portal"), 500, "INTERNAL_ERROR");
  } finally {
    await db.execute(sql`ALTER TABLE monthly_usage_unavailable RENAME TO monthly_usage`);
  }
  expect((await (await call("/usage")).json()).data.billable_calls).toBe(0);
});
