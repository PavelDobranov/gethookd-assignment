import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { EncryptJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import * as resources from "../src/ads/v1/resources.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { readUsage } from "../src/usage/billing.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_accounting_test";
const connection = createDatabase(url.href);
let server: Server;
let origin: string;
let credential: string;
let ownerId: string;
let keyId: string;
let sequence = 0;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v1_accounting_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  // Simulate unknown delivery at the actual transport boundary, after settlement.
  const app = express();
  app.use((req, res, next) => {
    const send = res.send.bind(res);
    res.send = (body) => {
      if (req.headers["x-test-drop-delivery"] === "yes" && res.statusCode === 200) {
        res.destroy();
        return res;
      }
      return send(body);
    };
    next();
  });
  app.use(createApp({ db: connection.db, jwtSecret: "accounting-jwt-secret" }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}/api/v1`;
  await connection.db.insert(brands).values({ id: 99001, name: "Accounting brand" });
  await connection.db.insert(ads).values(
    ["accounting-a", "accounting-b"].map((id) => ({
      id,
      brandId: 99001,
      headline: id,
      bodyText: "Current body",
      niche: "pet-supplies",
      format: "image",
      status: "active",
      countries: ["US"],
      startDate: "2026-01-01",
      discoveredAt: new Date("2026-01-01T00:00:00Z"),
    })),
  );
});
beforeEach(async () => {
  credential = `accounting-${++sequence}`;
  const [owner] = await connection.db
    .insert(users)
    .values({ username: credential, passwordHash: "unused" })
    .returning();
  ownerId = owner.id;
  const [key] = await connection.db
    .insert(apiKeys)
    .values(apiKeyFixture(ownerId, hashApiKey(credential), credential))
    .returning();
  keyId = key.id;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});
function request(path = "/ads", header?: string, key = credential, drop = false) {
  return fetch(`${origin}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      ...(header === undefined ? {} : { "Idempotency-Key": header }),
      ...(drop ? { "x-test-drop-delivery": "yes" } : {}),
    },
  });
}
async function count() {
  return (await readUsage(connection.db, ownerId)).data.billable_calls;
}
async function bindings() {
  return (await connection.db.execute(sql`SELECT * FROM billing_bindings WHERE api_key_id = ${keyId}::uuid`)).rows;
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).error.code).toBe(code);
}
it("charges empty search, nonempty search, detail and continuation; no header creates no binding", async () => {
  expect((await request("/ads?q=absent-result")).status).toBe(200);
  const first = await request("/ads?brand_id=99001&limit=1");
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(body.data).toHaveLength(1);
  expect(body.next_cursor).toEqual(expect.any(String));
  expect((await request(`/ads?cursor=${encodeURIComponent(body.next_cursor)}&limit=1`)).status).toBe(200);
  expect((await request("/ads/accounting-a")).status).toBe(200);
  expect(await count()).toBe(4);
  expect(await bindings()).toEqual([]);
});
it("matching live retries read current data for free without extending expiry", async () => {
  const path = "/ads/accounting-a";
  expect((await request(path, "detail-read")).status).toBe(200);
  const before = await bindings();
  await connection.db.update(ads).set({ bodyText: "Changed after settlement" }).where(eq(ads.id, "accounting-a"));
  const retry = await request(path, "detail-read");
  expect(retry.status).toBe(200);
  expect((await retry.json()).data.body_text).toBe("Changed after settlement");
  expect(await count()).toBe(1);
  expect(await bindings()).toEqual(before);
  expect((await request("/ads?q=empty", "empty-read")).status).toBe(200);
  expect((await request("/ads?q=empty", "empty-read")).status).toBe(200);
  expect(await count()).toBe(2);
});
it("conflict precedes quota while matching retries and niches remain free across keys sharing quota", async () => {
  expect((await request("/ads/accounting-a", "bound")).status).toBe(200);
  await connection.db.execute(sql`UPDATE monthly_usage SET count = 1000 WHERE owner_id = ${ownerId}::uuid`);
  await error(await request("/ads/accounting-b", "bound"), 409, "IDEMPOTENCY_CONFLICT");
  // Known conflict is rejected before even discovering the missing ad.
  await error(await request("/ads/missing", "bound"), 409, "IDEMPOTENCY_CONFLICT");
  expect((await request("/ads/accounting-a", "bound")).status).toBe(200);
  await error(await request("/ads", "new-intent"), 403, "QUOTA_EXCEEDED");
  const second = `${credential}-second`;
  await connection.db.insert(apiKeys).values(apiKeyFixture(ownerId, hashApiKey(second), second));
  await error(await request("/ads", undefined, second), 403, "QUOTA_EXCEEDED");
  expect((await request("/niches", "ignored invalid header!")).status).toBe(200);
  expect(await count()).toBe(1000);
  expect(await bindings()).toHaveLength(1);
});
it("validation, missing ads, header errors, invalid and expired cursors never charge or claim a binding", async () => {
  await error(await request("/ads?unknown=1", "failed"), 422, "VALIDATION_ERROR");
  await error(await request("/ads/missing", "failed"), 404, "AD_NOT_FOUND");
  await error(await request("/ads", "invalid value!"), 422, "VALIDATION_ERROR");
  await error(await request("/ads?cursor=bad", "failed"), 422, "INVALID_CURSOR");
  // Obtain a genuine cursor under a previous ad/cursor clock, not the database billing clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  let cursor: string;
  try {
    const first = await request("/ads?brand_id=99001&limit=1");
    expect(first.status).toBe(200);
    cursor = (await first.json()).next_cursor;
    vi.setSystemTime(new Date("2026-01-01T00:30:00Z"));
    await error(await request(`/ads?cursor=${encodeURIComponent(cursor)}`, "failed"), 422, "CURSOR_EXPIRED");
  } finally {
    vi.useRealTimers();
  }
  expect(await count()).toBe(1);
  expect(await bindings()).toEqual([]);
});
it("scope and input validation precede billing conflicts and quota decisions", async () => {
  expect((await request("/ads", "bound")).status).toBe(200);
  await error(await request("/ads?unknown=1", "bound"), 422, "VALIDATION_ERROR");
  await connection.db
    .update(apiKeys)
    .set({ scopes: ["keys:manage"] })
    .where(eq(apiKeys.id, keyId));
  await error(await request("/ads/accounting-a", "bound"), 403, "INSUFFICIENT_SCOPE");
  expect(await count()).toBe(1);
});
it("read and full JSON serialization failures occur before settlement and preserve existing bindings", async () => {
  expect((await request("/ads/accounting-a", "bound")).status).toBe(200);
  const before = await bindings();
  const getAd = vi.spyOn(resources, "getAd");
  try {
    getAd.mockRejectedValueOnce(new Error("read failed"));
    await error(await request("/ads/accounting-a", "bound"), 500, "INTERNAL_ERROR");
    getAd.mockImplementationOnce(async () => {
      throw new Error("mapping failed");
    });
    await error(await request("/ads/accounting-a", "unclaimed"), 500, "INTERNAL_ERROR");
    const ad = await resources.getAd(connection.db, "accounting-a");
    if (!ad) throw new Error("Expected fixture ad");
    getAd.mockResolvedValueOnce(
      Object.assign(ad, {
        toJSON() {
          throw new Error("serialization failed");
        },
      }),
    );
    await error(await request("/ads/accounting-a", "unclaimed"), 500, "INTERNAL_ERROR");
  } finally {
    getAd.mockRestore();
  }
  expect(await count()).toBe(1);
  expect(await bindings()).toEqual(before);
});
it("search mapping, cursor encoding and JSON serialization all precede settlement", async () => {
  const path = "/ads?brand_id=99001&limit=1";
  expect((await request(path, "prepared-search")).status).toBe(200);
  const before = await bindings();
  const mapSummary = resources.mapAdSummary;
  const mapping = vi.spyOn(resources, "mapAdSummary");
  const encoding = vi.spyOn(EncryptJWT.prototype, "encrypt");
  try {
    mapping.mockImplementationOnce(() => {
      throw new Error("search mapping failed");
    });
    await error(await request(path, "prepared-search"), 500, "INTERNAL_ERROR");
    encoding.mockRejectedValueOnce(new Error("cursor encryption failed"));
    await error(await request(path, "unclaimed"), 500, "INTERNAL_ERROR");
    mapping.mockImplementationOnce((row, now) =>
      Object.assign(mapSummary(row, now), {
        toJSON() {
          throw new Error("search serialization failed");
        },
      }),
    );
    await error(await request(path, "unclaimed"), 500, "INTERNAL_ERROR");
  } finally {
    mapping.mockRestore();
    encoding.mockRestore();
  }
  expect(await count()).toBe(1);
  expect(await bindings()).toEqual(before);
});

function legacy(query = "", header?: string, key = credential, path = "/ads", method = "GET") {
  return fetch(`${origin.replace("/api/v1", "/api/v0")}${path}?api_key=${key}&${query}`, {
    method,
    headers: header === undefined ? {} : { "Idempotency-Key": header },
  });
}
async function legacyError(response: Response) {
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Invalid request" });
}
it("v0 bills effective forgiving pages, keeps failures free and separates endpoint/key bindings", async () => {
  expect((await legacy("q=absent&niche=unknown&per_page=101", "mixed")).status).toBe(200);
  expect((await legacy("per_page=100&q=absent&ignored=yes", "mixed")).status).toBe(200);
  expect(await count()).toBe(1);
  await error(await request("/ads?q=absent", "mixed"), 409, "IDEMPOTENCY_CONFLICT");
  await legacyError(await legacy("page=2", "mixed"));
  await legacyError(await legacy("page=bad", "unused"));
  await legacyError(await legacy("", "bad value!"));
  expect((await legacy("page=999")).status).toBe(200);
  const second = `${credential}-second`;
  await connection.db.insert(apiKeys).values(apiKeyFixture(ownerId, hashApiKey(second), second));
  expect((await legacy("q=absent", "mixed", second)).status).toBe(200);
  expect(await count()).toBe(3);
  await connection.db.execute(sql`UPDATE monthly_usage SET count = 1000 WHERE owner_id = ${ownerId}::uuid`);
  expect((await legacy("q=absent&per_page=100", "mixed")).status).toBe(200);
  await legacyError(await legacy());
  await error(await request(), 403, "QUOTA_EXCEEDED");
  expect(await count()).toBe(1000);
});
it("v0 and v1 share admissions including authenticated invalid paths, methods and parameters", async () => {
  await legacyError(await legacy("page=bad"));
  await legacyError(await legacy("", undefined, credential, "/unknown"));
  await legacyError(await legacy("", undefined, credential, "/ads", "POST"));
  // Ambiguous/missing/invalid credentials must not consume this key's allowance.
  await legacyError(await legacy(`api_key=${credential}`));
  await legacyError(await legacy("", undefined, "wrong"));
  for (let i = 0; i < 57; i++) expect((await request("/niches")).status).toBe(200);
  const limited = await legacy("page=bad");
  expect(limited.status).toBe(429);
  const wait = Number(limited.headers.get("retry-after"));
  expect(wait).toBeGreaterThanOrEqual(1);
  expect(wait).toBeLessThanOrEqual(60);
  const body = await limited.json();
  expect(body.error.code).toBe("RATE_LIMITED");
  expect(body.error.retryable).toBe(true);
  expect(body.error.next_action).toContain(String(wait));
  await error(await request("/niches"), 429, "RATE_LIMITED");
  expect(await count()).toBe(0);
});
it("v0 maps scope and internal failures to generic errors without charging", async () => {
  await connection.db
    .update(apiKeys)
    .set({ scopes: ["keys:manage"] })
    .where(eq(apiKeys.id, keyId));
  await legacyError(await legacy());
  await connection.db
    .update(apiKeys)
    .set({ scopes: ["search:read"] })
    .where(eq(apiKeys.id, keyId));
  await connection.db.execute(sql`ALTER TABLE monthly_usage RENAME TO monthly_usage_unavailable`);
  try {
    await legacyError(await legacy());
  } finally {
    await connection.db.execute(sql`ALTER TABLE monthly_usage_unavailable RENAME TO monthly_usage`);
  }
  expect(await count()).toBe(0);
});

it("lost delivery stays durably charged; header retry is free, no-header retry is a new charge", async () => {
  await expect(request("/ads/accounting-a", "lost", credential, true)).rejects.toThrow();
  expect(await count()).toBe(1);
  expect(await bindings()).toHaveLength(1);
  expect((await request("/ads/accounting-a", "lost")).status).toBe(200);
  expect(await count()).toBe(1);
  await expect(request("/ads/accounting-a", undefined, credential, true)).rejects.toThrow();
  expect(await count()).toBe(2);
  expect((await request("/ads/accounting-a")).status).toBe(200);
  expect(await count()).toBe(3);
});
