import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { apiKeys, users } from "../src/db/schema.js";
import { readUsage } from "../src/usage/billing.js";
import * as transactions from "../src/usage/transactions.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_http_accounting_test";
// Every app session is deliberately non-UTC; accounting must still select UTC months.
url.searchParams.set("options", "-c timezone=America/Los_Angeles");
const monitor = createDatabase(url.href);
const { db } = monitor;
const jwtSecret = "http-accounting-test-jwt";
type App = { connection: ReturnType<typeof createDatabase>; server: Server; origin: string };
let apps: App[] = [];
let ownerId: string;
let keys: { id: string; credential: string }[];
let sequence = 0;
let ingress: { arrived: number; size: number; release: Promise<void>; open: () => void } | undefined;

async function start(): Promise<App> {
  const connection = createDatabase(url.href);
  const app = express();
  app.use(async (req, res, next) => {
    if (req.headers["x-test-ingress"] && ingress) {
      const barrier = ingress;
      if (++barrier.arrived === barrier.size) barrier.open();
      await barrier.release;
    }
    const send = res.send.bind(res);
    res.send = (body) => {
      if (req.headers["x-test-drop"] && res.statusCode === 200) {
        res.destroy();
        return res;
      }
      return send(body);
    };
    next();
  });
  app.use(createApp({ db: connection.db, jwtSecret }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return { connection, server, origin: `http://127.0.0.1:${address.port}` };
}
async function stop(app: App) {
  await new Promise<void>((resolve, reject) => app.server.close((err) => (err ? reject(err) : resolve())));
  await app.connection.close();
}
beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_http_accounting_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  apps = await Promise.all([start(), start()]);
});
beforeEach(async () => {
  const name = `http-races-${++sequence}`;
  const [owner] = await db.insert(users).values({ username: name, passwordHash: "unused" }).returning();
  ownerId = owner.id;
  keys = [];
  for (let i = 0; i < 2; i++) {
    const credential = `${name}-${i}`;
    const [key] = await db
      .insert(apiKeys)
      .values(apiKeyFixture(ownerId, hashApiKey(credential), credential))
      .returning();
    keys.push({ id: key.id, credential });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  ingress = undefined;
});
afterAll(async () => {
  await Promise.all(apps.map(stop));
  await monitor.close();
});
function call(
  index = 0,
  path = "/api/v1/ads?q=http-absent",
  header?: string,
  key = keys[0].credential,
  options: RequestInit = {},
) {
  const legacy = path.startsWith("/api/v0/");
  return fetch(`${apps[index].origin}${path}${legacy ? `${path.includes("?") ? "&" : "?"}api_key=${key}` : ""}`, {
    ...options,
    headers: {
      ...(legacy ? {} : { Authorization: `Bearer ${key}` }),
      ...(header === undefined ? {} : { "Idempotency-Key": header }),
      ...options.headers,
    },
  });
}
async function meter() {
  return (await readUsage(db, ownerId)).data.billable_calls;
}
async function bindings() {
  return (
    await db.execute(sql`SELECT b.* FROM billing_bindings b JOIN api_keys k ON k.id = b.api_key_id
    WHERE k.user_id = ${ownerId}::uuid ORDER BY b.api_key_id, b.value_hash`)
  ).rows;
}
async function rate(key = keys[0].id) {
  return (
    await db.execute(sql`SELECT rate_admissions::text AS admissions, last_used_at::text AS used,
    cardinality(rate_admissions) AS count FROM api_keys WHERE id = ${key}::uuid`)
  ).rows[0];
}
async function rich(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: {
      code,
      message: status === 500 ? "The request could not be completed." : expect.any(String),
      next_action: status === 500 ? "Retry after a short delay; do not retry in a tight loop." : expect.any(String),
      retryable: status === 500 || status === 429,
      details: status === 500 ? [] : expect.any(Array),
    },
  });
}
// PostgreSQL completion is the polling yield; no sleep or timing guess establishes overlap.
async function ownerWaiters(count: number) {
  const deadline = Date.now() + 1500;
  do {
    const { rows } = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%FROM users%FOR NO KEY UPDATE%'`);
    if (rows[0].count >= count) return;
  } while (Date.now() < deadline);
  throw new Error("Expected HTTP requests waiting at owner settlement lock");
}
async function lockOwner() {
  const client = await db.$client.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [ownerId]);
  return client;
}
async function synchronized(requests: (() => Promise<Response>)[]) {
  const holder = await lockOwner();
  // Attach a rejection handler immediately, even if observing the barrier fails.
  const pending = Promise.all(requests.map((request) => request()));
  void pending.catch(() => {});
  try {
    await ownerWaiters(requests.length);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  return pending;
}

it.each(["identical", "different", "no-header", "separate-keys"] as const)(
  "settles synchronized independent-app HTTP requests with %s intents",
  async (mode) => {
    const responses = await synchronized(
      Array.from(
        { length: 4 },
        (_, i) => () =>
          call(
            i % 2,
            mode === "different" ? `/api/v1/ads?q=absent-${i}` : "/api/v1/ads?q=http-absent",
            mode === "no-header" ? undefined : "one-intent",
            mode === "separate-keys" ? keys[i % 2].credential : keys[0].credential,
          ),
      ),
    );
    const successes = responses.filter((r) => r.status === 200);
    expect(successes).toHaveLength(mode === "different" ? 1 : 4);
    for (const response of responses.filter((r) => r.status !== 200)) await rich(response, 409, "IDEMPOTENCY_CONFLICT");
    expect(await meter()).toBe(mode === "no-header" ? 4 : mode === "separate-keys" ? 2 : 1);
    expect(await bindings()).toHaveLength(mode === "no-header" ? 0 : mode === "separate-keys" ? 2 : 1);
    expect(Number((await rate()).count) + Number((await rate(keys[1].id)).count)).toBe(4);
  },
  10000,
);
it.each([false, true])("allows one mixed-version/key winner at 999 (header=%s)", async (withHeader) => {
  await db.execute(sql`INSERT INTO monthly_usage (owner_id, period_start, count)
    VALUES (${ownerId}, date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date, 999)`);
  const responses = await synchronized(
    Array.from(
      { length: 4 },
      (_, i) => () =>
        call(
          i % 2,
          i % 2 ? "/api/v0/ads?q=http-absent" : "/api/v1/ads?q=http-absent",
          withHeader ? `distinct-${i}` : undefined,
          keys[i % 2].credential,
        ),
    ),
  );
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  for (let i = 0; i < responses.length; i++) {
    const response = responses[i];
    if (response.status === 200) continue;
    if (i % 2) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request" });
    } else await rich(response, 403, "QUOTA_EXCEEDED");
  }
  expect(await meter()).toBe(1000);
  expect(await bindings()).toHaveLength(withHeader ? 1 : 0);
});
it("rolls back a failed HTTP settlement including cleanup, while retaining admission and a live binding", async () => {
  expect((await call(0, undefined, "live")).status).toBe(200);
  await db.execute(sql`INSERT INTO billing_bindings VALUES
    (${keys[0].id}, 'expired', 'expired', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day')`);
  const before = await bindings();
  await db.execute(sql`ALTER TABLE billing_bindings ADD CONSTRAINT fail_http_settlement
    CHECK (false) NOT VALID`);
  try {
    await rich(await call(1, undefined, "rollback"), 500, "INTERNAL_ERROR");
    expect(await meter()).toBe(1);
    expect(await bindings()).toEqual(before);
    expect((await rate()).count).toBe(2);
  } finally {
    await db.execute(sql`ALTER TABLE billing_bindings DROP CONSTRAINT fail_http_settlement`);
  }
  expect((await call(1, undefined, "rollback")).status).toBe(200);
  expect(await meter()).toBe(2);
  expect(await bindings()).toHaveLength(2);
  expect((await bindings()).find((b) => b.value_hash === hashApiKey("live"))).toEqual(
    before.find((b) => b.value_hash === hashApiKey("live")),
  );
  expect((await call(0, undefined, "live")).status).toBe(200);
  expect(await meter()).toBe(2);
});
it("captures settlement time after owner contention and honors exact cross-month expiry over HTTP", async () => {
  let instant = "2028-02-29T23:59:59.123456Z";
  vi.spyOn(transactions, "databaseTime").mockImplementation(
    async (tx) =>
      (await tx.execute<{ instant: string }>(sql`SELECT ${instant}::timestamptz::text AS instant`)).rows[0].instant,
  );
  const holder = await lockOwner();
  const pending = call(0, undefined, "boundary");
  void pending.catch(() => {});
  try {
    await ownerWaiters(1);
    instant = "2028-03-01T00:00:00.123456Z";
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  expect((await pending).status).toBe(200);
  expect(await readUsage(db, ownerId)).toEqual({
    data: {
      period_start: "2028-03-01T00:00:00.000Z",
      period_end: "2028-04-01T00:00:00.000Z",
      billable_calls: 1,
      quota: 1000,
      remaining: 999,
    },
  });
  const before = await bindings();
  instant = "2028-03-02T00:00:00.123455Z";
  expect((await call(1, undefined, "boundary")).status).toBe(200);
  expect(await meter()).toBe(1);
  expect(await bindings()).toEqual(before);
  instant = "2028-03-02T00:00:00.123456Z";
  // Preflight conflict detection uses real DB time; the injected clock controls final
  // settlement only. A matching fingerprint reaches that boundary and must bill anew.
  expect((await call(1, undefined, "boundary")).status).toBe(200);
  expect(await meter()).toBe(2);
  expect(await bindings()).toHaveLength(1);
});
it("admits exactly 60 simultaneous HTTP requests across apps, with nonrenewing denials and exact recovery", async () => {
  let instant = "2028-03-01T12:00:00.123456Z";
  vi.spyOn(transactions, "databaseTime").mockImplementation(async () => instant);
  let open = () => {};
  const release = new Promise<void>((resolve) => {
    open = resolve;
  });
  ingress = { arrived: 0, size: 64, release, open };
  const responses = await Promise.all(
    Array.from({ length: 64 }, (_, i) =>
      call(i % 2, "/api/v1/niches", undefined, keys[0].credential, { headers: { "x-test-ingress": "yes" } }),
    ),
  );
  expect(responses.filter((r) => r.status === 200)).toHaveLength(60);
  expect(responses.filter((r) => r.status === 429)).toHaveLength(4);
  const before = await rate();
  expect(before.count).toBe(60);
  instant = "2028-03-01T12:00:30.123456Z";
  for (let i = 0; i < 2; i++) {
    const response = await call(i, "/api/v0/unsupported");
    expect(response.headers.get("retry-after")).toBe("30");
    await rich(response, 429, "RATE_LIMITED");
  }
  expect((await rate()).admissions).toEqual(before.admissions);
  expect((await call(1, "/api/v1/niches", undefined, keys[1].credential)).status).toBe(200);
  instant = "2028-03-01T12:01:00.123455Z";
  const justBefore = await call(0, "/api/v1/niches");
  expect(justBefore.headers.get("retry-after")).toBe("1");
  await rich(justBefore, 429, "RATE_LIMITED");
  instant = "2028-03-01T12:01:00.123456Z";
  expect((await call(1, "/api/v1/niches")).status).toBe(200);
  expect((await rate()).count).toBe(1);
  expect(await meter()).toBe(0);
}, 15000);
it("permits an admitted in-flight read after revocation but rejects the next authentication", async () => {
  const holder = await lockOwner();
  const pending = call(0, undefined, "in-flight");
  void pending.catch(() => {});
  try {
    await ownerWaiters(1);
    expect(
      (await call(1, `/api/v1/keys/${keys[0].id}`, undefined, keys[1].credential, { method: "DELETE" })).status,
    ).toBe(204);
    const before = await rate();
    await rich(await call(1), 401, "UNAUTHENTICATED");
    expect(await rate()).toEqual(before);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  expect((await pending).status).toBe(200);
  expect(await meter()).toBe(1);
  await rich(await call(0), 401, "UNAUTHENTICATED");
});
it("maps settlement lock timeout to sanitized server failure, never a fabricated conflict", async () => {
  const holder = await lockOwner();
  try {
    await rich(await call(1, undefined, "timed-out"), 500, "INTERNAL_ERROR");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  expect(await meter()).toBe(0);
  expect(await bindings()).toEqual([]);
  expect((await rate()).count).toBe(1);
  expect((await call(0, undefined, "timed-out")).status).toBe(200);
  expect(await meter()).toBe(1);
});
it("preserves committed lost delivery, live bindings, revoked fixture and allowance through app/pool restart and setup", async () => {
  await expect(call(0, undefined, "lost", undefined, { headers: { "x-test-drop": "yes" } })).rejects.toThrow();
  expect(await meter()).toBe(1);
  const live = await bindings();
  const publicCredential = "gethookd-public-demo-api-key-m2";
  const [fixture] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(publicCredential)));
  expect((await call(0, `/api/v1/keys/${fixture.id}`, undefined, publicCredential, { method: "DELETE" })).status).toBe(
    204,
  );
  const fixtureBefore = (await db.select().from(apiKeys).where(eq(apiKeys.id, fixture.id)))[0];
  const rateBefore = await rate();
  await Promise.all(apps.map(stop));
  apps = [];
  await initializeDatabase(url.href);
  apps = await Promise.all([start(), start()]);
  expect(await bindings()).toEqual(live);
  expect(await meter()).toBe(1);
  expect(await rate()).toEqual(rateBefore);
  expect((await db.select().from(apiKeys).where(eq(apiKeys.id, fixture.id)))[0]).toEqual(fixtureBefore);
  await rich(await call(1, "/api/v1/niches", undefined, publicCredential), 401, "UNAUTHENTICATED");
  expect((await call(1, undefined, "lost")).status).toBe(200);
  expect(await bindings()).toEqual(live);
  expect(await meter()).toBe(1);
  expect((await call(0)).status).toBe(200);
  expect(await meter()).toBe(2);
  const token = await signToken(ownerId, jwtSecret);
  const api = await (await call(1, "/api/v1/usage")).json();
  const portal = await fetch(`${apps[0].origin}/api/portal/usage`, { headers: { Authorization: `Bearer ${token}` } });
  expect(portal.status).toBe(200);
  expect(await portal.json()).toEqual(api);
  expect(api.data.billable_calls).toBe(2);
}, 20000);
