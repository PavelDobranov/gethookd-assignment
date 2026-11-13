import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { hashApiKey } from "../src/api-keys/index.js";
import { createDatabase } from "../src/db/client.js";
import { apiKeys, users } from "../src/db/schema.js";
import { admitApiKey } from "../src/usage/admission.js";
import type { AccountingClock } from "../src/usage/transactions.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_admission";
const connection = createDatabase(url.href);
const other = createDatabase(url.href);
const { db } = connection;
const start = "2028-02-29T23:59:59.123456Z";
const at =
  (instant: string): AccountingClock =>
  async () =>
    instant;
let keyId: string;
const state = async () =>
  (
    await db.execute(sql`SELECT last_used_at::text,
  ARRAY(SELECT a::text FROM unnest(rate_admissions) a) AS admissions FROM api_keys WHERE id = ${keyId}`)
  ).rows[0];

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_admission`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  await Promise.all([connection.close(), other.close()]);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE api_keys, users CASCADE`);
  const [owner] = await db.insert(users).values({ username: "owner", passwordHash: "test-hash" }).returning();
  const [key] = await db
    .insert(apiKeys)
    .values(apiKeyFixture(owner.id, hashApiKey("first")))
    .returning();
  keyId = key.id;
  await db.insert(apiKeys).values(apiKeyFixture(owner.id, hashApiKey("second")));
});

it("admits exactly 60 concurrent requests across independent pools, isolating keys", async () => {
  const results = await Promise.all(
    Array.from({ length: 64 }, (_, i) => admitApiKey(i % 2 ? db : other.db, "first", at(start))),
  );
  expect(results.filter((r) => r?.allowed)).toHaveLength(60);
  expect(results.filter((r) => r && !r.allowed)).toHaveLength(4);
  for (const result of results) {
    expect(result?.identity).toMatchObject({ id: keyId, scopes: ["search:read", "keys:manage"] });
    if (result && !result.allowed) expect(result.retryAfter).toBe(60);
  }
  expect((await state()).admissions).toHaveLength(60);
  const restarted = createDatabase(url.href);
  try {
    expect(await admitApiKey(restarted.db, "first", at(start))).toMatchObject({ allowed: false, retryAfter: 60 });
  } finally {
    await restarted.close();
  }
  expect(await admitApiKey(other.db, "second", at(start))).toMatchObject({ allowed: true });
});

it("uses an exact rolling microsecond cutoff, ceil Retry-After and nonrenewing denials", async () => {
  await db.execute(
    sql`UPDATE api_keys SET rate_admissions = array_fill(${start}::timestamptz, ARRAY[60]) WHERE id = ${keyId}`,
  );
  for (const [instant, retryAfter] of [
    ["2028-03-01T00:00:00.123456Z", 59],
    ["2028-03-01T00:00:58.123455Z", 2],
    ["2028-03-01T00:00:59.123455Z", 1],
  ] as const) {
    expect(await admitApiKey(db, "first", at(instant))).toMatchObject({ allowed: false, retryAfter });
    expect((await state()).admissions).toHaveLength(60);
  }
  expect(await admitApiKey(db, "first", at("2028-03-01T00:00:59.123456Z"))).toMatchObject({ allowed: true });
  expect(await state()).toEqual({
    last_used_at: "2028-03-01 00:00:59.123456+00",
    admissions: ["2028-03-01 00:00:59.123456+00"],
  });
});

it("rolls back operational failures and uses absolute instants in a non-UTC session", async () => {
  const before = await state();
  await expect(
    admitApiKey(db, "first", async () => {
      throw new Error("store unavailable");
    }),
  ).rejects.toThrow("store unavailable");
  expect(await state()).toEqual(before);
  await admitApiKey(db, "first", async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Honolulu'`);
    return start;
  });
  expect(await state()).toEqual({
    last_used_at: "2028-02-29 23:59:59.123456+00",
    admissions: ["2028-02-29 23:59:59.123456+00"],
  });
});

it("persists across pool restart and later failures, and never regresses last-used", async () => {
  expect(await admitApiKey(db, "first", at(start))).toMatchObject({ allowed: true });
  // Later scope/validation/read/settlement errors cannot roll back the committed admission.
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      throw new Error("later operation failed");
    }),
  ).rejects.toThrow("later operation failed");
  const restarted = createDatabase(url.href);
  try {
    expect(await admitApiKey(restarted.db, "first", at("2028-02-29T23:59:58Z"))).toMatchObject({ allowed: true });
  } finally {
    await restarted.close();
  }
  expect((await state()).last_used_at).toBe("2028-02-29 23:59:59.123456+00");
  expect((await state()).admissions).toHaveLength(2);
  await db.execute(
    sql`UPDATE api_keys SET rate_admissions = array_fill(${start}::timestamptz, ARRAY[60]) WHERE id = ${keyId}`,
  );
  expect(await admitApiKey(other.db, "first", at("2028-03-01T00:00:01Z"))).toMatchObject({ allowed: false });
  expect((await state()).last_used_at).toBe("2028-03-01 00:00:01+00");
});

it("does not sample time or mutate state for invalid or revoked credentials", async () => {
  const never: AccountingClock = async () => {
    throw new Error("must not sample");
  };
  const before = await state();
  for (const credential of [undefined, "", "unknown", 123]) expect(await admitApiKey(db, credential, never)).toBeNull();
  await db.execute(sql`UPDATE api_keys SET revoked_at = ${start}::timestamptz WHERE id = ${keyId}`);
  expect(await admitApiKey(db, "first", never)).toBeNull();
  expect(await state()).toEqual(before);
});

it("samples after the key lock wait, fails closed on timeout and recovers", async () => {
  const holder = await db.$client.connect();
  let waiting: ReturnType<typeof admitApiKey> | undefined;
  let samples = 0;
  let instant = start;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM api_keys WHERE id = $1 FOR UPDATE", [keyId]);
    waiting = admitApiKey(other.db, "first", async () => {
      samples++;
      return instant;
    });
    const deadline = performance.now() + 400;
    let blocked = false;
    while (!blocked && performance.now() < deadline) {
      const { rows } = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`);
      blocked = Boolean(rows[0].blocked);
    }
    expect(blocked).toBe(true);
    expect(samples).toBe(0);
    instant = "2028-03-01T00:01:00.999999Z";
    await holder.query("COMMIT");
    expect(await waiting).toMatchObject({ allowed: true });
    expect((await state()).last_used_at).toBe("2028-03-01 00:01:00.999999+00");
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM api_keys WHERE id = $1 FOR UPDATE", [keyId]);
    const before = await state();
    await expect(admitApiKey(other.db, "first", at(start))).rejects.toThrow();
    expect(await state()).toEqual(before);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await waiting;
  }
  expect(await admitApiKey(other.db, "first", at(start))).toMatchObject({ allowed: true });
});
