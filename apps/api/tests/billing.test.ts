import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { apiKeys, users } from "../src/db/schema.js";
import { expiredBindingSelection, readUsage, settleBilling } from "../src/usage/billing.js";
import type { AccountingClock } from "../src/usage/transactions.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_billing";
const connection = createDatabase(url.href);
const other = createDatabase(url.href);
const { db } = connection;
let ownerId: string;
let keys: { id: string; userId: string }[];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const binding = (value = "intent", fingerprint = "search") => ({
  valueHash: hash(value),
  fingerprintHash: hash(fingerprint),
});
const at =
  (instant: string): AccountingClock =>
  async () =>
    instant;
const start = "2028-02-29T23:59:59.123456Z";
const meter = async () =>
  (await db.execute(sql`SELECT owner_id, period_start::text, count FROM monthly_usage ORDER BY period_start`)).rows;
const bindings = async () =>
  (
    await db.execute(sql`SELECT api_key_id, value_hash, fingerprint_hash,
  settled_at::text, expires_at::text FROM billing_bindings ORDER BY api_key_id, value_hash`)
  ).rows;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_billing`);
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
  ownerId = owner.id;
  keys = await db
    .insert(apiKeys)
    .values([apiKeyFixture(ownerId, "first"), apiKeyFixture(ownerId, "second")])
    .returning({ id: apiKeys.id, userId: apiKeys.userId });
});

it.each([0, 999])(
  "settles concurrent identical retries once at usage %i without renewing expiry",
  async (initialCount) => {
    await db.execute(sql`INSERT INTO monthly_usage VALUES (${ownerId}, '2028-02-01', ${initialCount})`);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => settleBilling(i % 2 ? db : other.db, keys[0], binding(), at(start))),
    );
    expect(results.filter((r) => r.charged)).toHaveLength(1);
    expect((await meter())[0].count).toBe(initialCount + 1);
    const before = await bindings();
    expect(before).toHaveLength(1);
    expect(before[0].value_hash).toBe(hash("intent"));
    expect(before[0].fingerprint_hash).toBe(hash("search"));
    await expect(settleBilling(other.db, keys[0], binding(), at("2028-03-01T23:59:59.123455Z"))).resolves.toEqual({
      charged: false,
    });
    expect(await bindings()).toEqual(before);
    expect(await readUsage(db, ownerId, at("2028-03-01T12:00:00Z"))).toEqual({
      data: {
        period_start: "2028-03-01T00:00:00.000Z",
        period_end: "2028-04-01T00:00:00.000Z",
        billable_calls: 0,
        quota: 1000,
        remaining: 1000,
      },
    });
  },
);

it("binds only one simultaneous differing fingerprint and conflicts before quota", async () => {
  const results = await Promise.allSettled([
    settleBilling(db, keys[0], binding("intent", "first"), at(start)),
    settleBilling(other.db, keys[0], binding("intent", "second"), at(start)),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected");
  expect(rejected).toMatchObject({ reason: { code: "IDEMPOTENCY_CONFLICT" } });
  expect((await meter())[0].count).toBe(1);
  const [stored] = await bindings();
  await db.execute(sql`UPDATE monthly_usage SET count = 1000`);
  const matching = { valueHash: hash("intent"), fingerprintHash: String(stored.fingerprint_hash) };
  await expect(settleBilling(db, keys[0], matching, at(start))).resolves.toEqual({ charged: false });
  await expect(settleBilling(db, keys[0], binding("intent", "different"), at(start))).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
  await expect(settleBilling(db, keys[0], binding("new"), at(start))).rejects.toMatchObject({
    code: "QUOTA_EXCEEDED",
    periodEnd: "2028-03-01T00:00:00.000Z",
  });
  expect(await bindings()).toEqual([stored]);
});

it("counts every no-header settlement, distinct values and separate key namespaces", async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => settleBilling(i % 2 ? db : other.db, keys[i % 2], undefined, at(start))),
  );
  expect(await bindings()).toEqual([]);
  await settleBilling(db, keys[0], binding("a"), at(start));
  await settleBilling(db, keys[0], binding("b"), at(start));
  await settleBilling(db, keys[1], binding("a"), at(start));
  expect((await meter())[0].count).toBe(11);
  expect(await bindings()).toHaveLength(3);
});

it.each([true, false])("allows exactly one cross-key winner at 999 (binding=%s)", async (withBinding) => {
  await db.execute(sql`INSERT INTO monthly_usage VALUES (${ownerId}, '2028-02-01', 999)`);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      settleBilling(i % 2 ? db : other.db, keys[i % 2], withBinding ? binding(`intent-${i}`) : undefined, at(start)),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const result of results.filter((r) => r.status === "rejected"))
    expect(result.reason).toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect((await meter())[0].count).toBe(1000);
  expect(await bindings()).toHaveLength(withBinding ? 1 : 0);
});

it("rebinds at exactly 24 hours, preserving microseconds and historical months", async () => {
  await settleBilling(db, keys[0], binding(), at(start));
  await expect(
    settleBilling(db, keys[0], binding("intent", "new"), at("2028-03-01T23:59:59.123455Z")),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    settleBilling(db, keys[0], binding("intent", "new"), at("2028-03-01T23:59:59.123456Z")),
  ).resolves.toEqual({ charged: true });
  expect((await meter()).map((r) => [r.period_start, r.count])).toEqual([
    ["2028-02-01", 1],
    ["2028-03-01", 1],
  ]);
  expect((await bindings())[0]).toMatchObject({
    settled_at: "2028-03-01 23:59:59.123456+00",
    expires_at: "2028-03-02 23:59:59.123456+00",
  });
});

it.each([
  ["2027-12-31T23:59:59.999999Z", "2027-12-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z"],
  ["2028-01-01T00:00:00Z", "2028-01-01T00:00:00.000Z", "2028-02-01T00:00:00.000Z"],
  ["2028-02-29T23:59:59.999999Z", "2028-02-01T00:00:00.000Z", "2028-03-01T00:00:00.000Z"],
  ["2027-02-28T23:59:59Z", "2027-02-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z"],
])("selects UTC calendar period for %s even in a non-UTC session", async (instant, periodStart, periodEnd) => {
  const clock: AccountingClock = async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Honolulu'`);
    return instant;
  };
  await settleBilling(db, keys[0], undefined, clock);
  expect(await readUsage(db, ownerId, clock)).toEqual({
    data: { period_start: periodStart, period_end: periodEnd, billable_calls: 1, quota: 1000, remaining: 999 },
  });
});

it("samples time and rechecks binding expiry only after the owner wait into a new period", async () => {
  await settleBilling(db, keys[0], binding(), at("2027-12-31T00:00:00.000001Z"));
  const holder = await db.$client.connect();
  let waiting: Promise<unknown> | undefined;
  let instant = "2027-12-31T23:59:59.999999Z";
  let samples = 0;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [ownerId]);
    waiting = settleBilling(other.db, keys[0], binding(), async () => {
      samples++;
      return instant;
    });
    // Observe the actual lock waiter rather than relying on timing/statistical races.
    const deadline = performance.now() + 400;
    let blocked = false;
    while (!blocked && performance.now() < deadline) {
      const { rows } = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`);
      blocked = Boolean(rows[0].blocked);
    }
    expect(blocked).toBe(true);
    expect(samples).toBe(0);
    instant = "2028-01-01T00:00:00.000001Z";
    await holder.query("COMMIT");
    await waiting;
    expect(samples).toBe(1);
    expect((await meter()).map((row) => [row.period_start, row.count])).toEqual([
      ["2027-12-01", 1],
      ["2028-01-01", 1],
    ]);
    expect((await bindings())[0].settled_at).toBe("2028-01-01 00:00:00.000001+00");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await waiting;
  }
});

it("rolls back both the charge and binding when binding persistence fails", async () => {
  await settleBilling(db, keys[0], binding(), at(start));
  await db.execute(sql`INSERT INTO billing_bindings VALUES
    (${keys[0].id}, 'expired', 'hash', '2027-01-01', '2027-01-02')`);
  // A real database failure after cleanup and the meter update must undo both.
  await db.execute(
    sql`ALTER TABLE billing_bindings ADD CONSTRAINT test_reject_binding CHECK (fingerprint_hash <> 'reject')`,
  );
  try {
    const before = await bindings();
    await expect(
      settleBilling(db, keys[0], { valueHash: hash("other"), fingerprintHash: "reject" }, at(start)),
    ).rejects.toBeDefined();
    expect((await meter())[0].count).toBe(1);
    expect(await bindings()).toEqual(before);
  } finally {
    await db.execute(sql`ALTER TABLE billing_bindings DROP CONSTRAINT test_reject_binding`);
  }
});

it("cleans at most 100 current-key expired rows, keeps live/dormant bindings and all meter history", async () => {
  await db.execute(sql`INSERT INTO monthly_usage VALUES (${ownerId}, '2027-01-01', 123)`);
  await db.execute(sql`INSERT INTO billing_bindings
    SELECT ${keys[0].id}::uuid, 'old-' || n, 'hash', '2027-01-01'::timestamptz, '2027-01-02'::timestamptz FROM generate_series(1, 105) n
    UNION ALL SELECT ${keys[0].id}::uuid, 'live', 'hash', '2028-02-29', '2028-03-01'
    UNION ALL SELECT ${keys[1].id}::uuid, 'dormant', 'hash', '2027-01-01', '2027-01-02'`);
  await settleBilling(db, keys[0], undefined, at(start));
  const retained = await bindings();
  expect(retained.filter((r) => r.api_key_id === keys[0].id)).toHaveLength(6);
  expect(retained.some((r) => r.value_hash === "live")).toBe(true);
  expect(retained.some((r) => r.value_hash === "dormant")).toBe(true);
  expect((await meter()).map((r) => r.count)).toEqual([123, 1]);
});

it("uses the current-key expiry index for bounded selection amid unrelated/live rows", async () => {
  await db.execute(sql`INSERT INTO api_keys (user_id, key_hash, prefix, scopes)
    SELECT ${ownerId}::uuid, 'bulk-' || n, 'test', ARRAY['search:read'] FROM generate_series(1, 100) n`);
  await db.execute(sql`INSERT INTO billing_bindings
    SELECT k.id, 'bulk-' || n, 'hash', '2027-01-01', CASE WHEN n <= 2 THEN '2027-01-02'::timestamptz ELSE '2029-01-02'::timestamptz END
    FROM api_keys k CROSS JOIN generate_series(1, 200) n`);
  await db.execute(sql`ANALYZE billing_bindings`);
  const { rows } = await db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${expiredBindingSelection(keys[0].id, start)}`);
  const plan = JSON.stringify(rows);
  expect(plan).toContain("billing_bindings_key_expiry_idx");
  expect(plan).not.toContain('"Node Type":"Seq Scan"');
});

it("keeps expiry exactly 24 elapsed hours across a daylight-saving transition", async () => {
  const clockAt =
    (instant: string): AccountingClock =>
    async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/New_York'`);
      return instant;
    };
  await settleBilling(db, keys[0], binding(), clockAt("2028-03-11T17:00:00.123456Z"));
  const { rows } = await db.execute(sql`SELECT extract(epoch FROM expires_at - settled_at)::integer AS seconds
    FROM billing_bindings`);
  expect(rows).toEqual([{ seconds: 86400 }]);
  await expect(settleBilling(db, keys[0], binding(), clockAt("2028-03-12T17:00:00.123455Z"))).resolves.toEqual({
    charged: false,
  });
  await expect(settleBilling(db, keys[0], binding(), clockAt("2028-03-12T17:00:00.123456Z"))).resolves.toEqual({
    charged: true,
  });
  expect((await meter())[0].count).toBe(2);
});

it("fails closed if cleanup fails, preserving the meter and bindings", async () => {
  await db.execute(
    sql`INSERT INTO billing_bindings VALUES (${keys[0].id}, 'expired', 'hash', '2027-01-01', '2027-01-02')`,
  );
  await db.execute(
    sql`CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup unavailable'; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER reject_cleanup BEFORE DELETE ON billing_bindings FOR EACH ROW EXECUTE FUNCTION reject_cleanup()`,
  );
  try {
    await expect(settleBilling(db, keys[0], binding(), at(start))).rejects.toBeDefined();
    expect(await meter()).toEqual([]);
    expect(await bindings()).toHaveLength(1);
  } finally {
    await db.execute(sql`DROP TRIGGER reject_cleanup ON billing_bindings`);
    await db.execute(sql`DROP FUNCTION reject_cleanup()`);
  }
});

it("reads the durable meter without ownership leakage, including after revocation", async () => {
  await settleBilling(db, keys[0], binding(), at(start));
  await db.execute(sql`UPDATE api_keys SET revoked_at = clock_timestamp()`);
  const [owner] = await db.insert(users).values({ username: "other", passwordHash: "hash" }).returning();
  expect((await readUsage(other.db, ownerId, at(start))).data.billable_calls).toBe(1);
  expect((await readUsage(db, owner.id, at(start))).data.billable_calls).toBe(0);
  // A newly opened pool observes the committed result; no process-local meter/replay state.
  const reopened = createDatabase(url.href);
  try {
    await expect(settleBilling(reopened.db, keys[0], binding(), at(start))).resolves.toEqual({ charged: false });
  } finally {
    await reopened.close();
  }
  expect((await meter())[0].count).toBe(1);
});
