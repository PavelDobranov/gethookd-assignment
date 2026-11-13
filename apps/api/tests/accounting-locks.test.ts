import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { createApiKey, revokeApiKey } from "../src/api-keys/lifecycle.js";
import { createDatabase } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { type ControlTransaction, controlTransaction, databaseTime } from "../src/usage/transactions.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_accounting_locks";
const connection = createDatabase(url.href);
const { db } = connection;
// One connection per independent pool makes session reuse/death observable.
function peer() {
  const pool = new pg.Pool({
    connectionString: url.href,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2000,
  });
  pool.on("error", () => {}); // Transaction-timeout eviction can race client release.
  return { pool, db: drizzle({ client: pool, schema }) };
}
const holder = peer();
const contender = peer();
const revoker = peer();
let ownerId: string;
let keyId: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_accounting_locks`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
  const version = await db.execute(sql`SELECT current_setting('server_version_num')::int / 10000 AS major`);
  expect(version.rows[0].major).toBe(17);
});
afterAll(async () => {
  await Promise.all([connection.close(), holder.pool.end(), contender.pool.end(), revoker.pool.end()]);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE users CASCADE`);
  const [owner] = await db.insert(schema.users).values({ username: "owner", passwordHash: "test-hash" }).returning();
  ownerId = owner.id;
  const [key] = await db.insert(schema.apiKeys).values(apiKeyFixture(ownerId, randomUUID())).returning();
  keyId = key.id;
});

async function backend(database: typeof db) {
  return (await database.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
}

// Query completion is the polling yield; no elapsed sleep establishes ordering.
async function blockedBy(waiter: number, blocker: number) {
  const deadline = Date.now() + 1000;
  do {
    const result = await db.execute(sql`SELECT ${blocker} = ANY(pg_blocking_pids(${waiter})) AS blocked`);
    if (result.rows[0].blocked) return;
  } while (Date.now() < deadline);
  throw new Error(`Backend ${waiter} did not block on ${blocker}`);
}

// Attach rejection handling immediately, including while observing lock barriers.
function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

async function settings(database: typeof db | ControlTransaction) {
  return (
    await database.execute(sql`SELECT current_setting('lock_timeout') AS lock,
    current_setting('transaction_timeout') AS transaction,
    current_setting('statement_timeout') AS statement`)
  ).rows[0];
}

async function snapshot() {
  return (
    await db.execute(sql`SELECT json_build_object(
    'usage', (SELECT json_agg(monthly_usage ORDER BY owner_id, period_start) FROM monthly_usage),
    'bindings', (SELECT json_agg(billing_bindings ORDER BY api_key_id, value_hash) FROM billing_bindings),
    'rates', (SELECT rate_admissions::text FROM api_keys WHERE id = ${keyId})
  )::text AS state`)
  ).rows[0].state;
}

async function writeAccounting(tx: ControlTransaction) {
  await tx.execute(sql`INSERT INTO monthly_usage (owner_id, period_start, count)
    VALUES (${ownerId}, '2026-10-01', 9)`);
  await tx.execute(sql`UPDATE api_keys SET rate_admissions = ARRAY[clock_timestamp()] WHERE id = ${keyId}`);
  await tx.execute(sql`INSERT INTO billing_bindings
    (api_key_id, value_hash, fingerprint_hash, settled_at, expires_at)
    VALUES (${keyId}, 'value', 'fingerprint', clock_timestamp(), clock_timestamp() + interval '1 day')`);
}

it.each([-1, 1001])("rejects monthly usage count %i", async (count) => {
  await expect(
    db.execute(sql`INSERT INTO monthly_usage (owner_id, period_start, count)
    VALUES (${ownerId}, '2026-10-01', ${count})`),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
});

it("accepts both usage bounds and keys it by owner and period", async () => {
  await db.execute(sql`INSERT INTO monthly_usage (owner_id, period_start, count) VALUES (${ownerId}, '2026-10-01', 0)`);
  expect((await db.execute(sql`SELECT count FROM monthly_usage`)).rows).toEqual([{ count: 0 }]);
  await db.execute(sql`UPDATE monthly_usage SET count = 1000`);
  await expect(
    db.execute(sql`INSERT INTO monthly_usage (owner_id, period_start, count)
    VALUES (${ownerId}, '2026-10-01', 0)`),
  ).rejects.toMatchObject({ cause: { code: "23505" } });
  await db.execute(sql`INSERT INTO monthly_usage (owner_id, period_start, count) VALUES (${ownerId}, '2026-11-01', 0)`);
  const otherOwner = randomUUID();
  await db.insert(schema.users).values({ id: otherOwner, username: "other", passwordHash: "test-hash" });
  await db.execute(
    sql`INSERT INTO monthly_usage (owner_id, period_start, count) VALUES (${otherOwner}, '2026-10-01', 0)`,
  );
  await expect(db.execute(sql`UPDATE monthly_usage SET count = NULL`)).rejects.toMatchObject({
    cause: { code: "23502" },
  });
});

it("enforces accounting foreign keys", async () => {
  await expect(
    db.execute(sql`INSERT INTO monthly_usage (owner_id, period_start, count)
    VALUES (${randomUUID()}, '2026-10-01', 0)`),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await expect(
    db.execute(sql`INSERT INTO billing_bindings
    (api_key_id, value_hash, fingerprint_hash, settled_at, expires_at)
    VALUES (${randomUUID()}, 'value', 'fingerprint', clock_timestamp(), clock_timestamp())`),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await expect(db.insert(schema.apiKeys).values(apiKeyFixture(randomUUID(), randomUUID()))).rejects.toMatchObject({
    cause: { code: "23503" },
  });
});

it("keys bindings by key/value, permits repeated fingerprints, and indexes expiry per key", async () => {
  await controlTransaction(db, writeAccounting);
  await expect(db.execute(sql`INSERT INTO billing_bindings SELECT * FROM billing_bindings`)).rejects.toMatchObject({
    cause: { code: "23505" },
  });
  await db.execute(sql`INSERT INTO billing_bindings
    SELECT api_key_id, 'another-value', fingerprint_hash, settled_at, expires_at FROM billing_bindings`);
  const [otherKey] = await db.insert(schema.apiKeys).values(apiKeyFixture(ownerId, randomUUID())).returning();
  await db.execute(sql`INSERT INTO billing_bindings
    SELECT ${otherKey.id}::uuid, value_hash, fingerprint_hash, settled_at, expires_at FROM billing_bindings
    WHERE api_key_id = ${keyId}`);
  const indexes = await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'billing_bindings'`);
  expect(indexes.rows.some((row) => String(row.indexdef).includes("(api_key_id, expires_at)"))).toBe(true);
});

it.each(["value_hash", "fingerprint_hash", "settled_at", "expires_at"])("requires binding %s", async (column) => {
  await controlTransaction(db, writeAccounting);
  await expect(db.execute(sql`UPDATE billing_bindings SET ${sql.identifier(column)} = NULL`)).rejects.toMatchObject({
    cause: { code: "23502", column },
  });
});

it("defaults admissions to empty, accepts 60, and rejects 61 or NULL", async () => {
  expect((await db.execute(sql`SELECT cardinality(rate_admissions) AS count FROM api_keys`)).rows).toEqual([
    { count: 0 },
  ]);
  await db.execute(sql`UPDATE api_keys SET rate_admissions = array_fill(clock_timestamp(), ARRAY[60])`);
  expect((await db.execute(sql`SELECT cardinality(rate_admissions) AS count FROM api_keys`)).rows).toEqual([
    { count: 60 },
  ]);
  await expect(
    db.execute(sql`UPDATE api_keys SET rate_admissions = array_fill(clock_timestamp(), ARRAY[61])`),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  await expect(db.execute(sql`UPDATE api_keys SET rate_admissions = NULL`)).rejects.toMatchObject({
    cause: { code: "23502" },
  });
});

it("serializes key FOR UPDATE across pools and captures the database clock only after the lock", async () => {
  const waiter = await backend(contender.db);
  const blocker = await backend(holder.db);
  let pending: Promise<unknown> | undefined;
  let releasedAt = "";
  let capturedAt = "";
  try {
    await holder.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM api_keys WHERE id = ${keyId} FOR UPDATE`);
      await tx.execute(sql`UPDATE api_keys SET rate_admissions = ARRAY['2026-10-05 12:00:00.123456+00'::timestamptz]
        WHERE id = ${keyId}`);
      pending = outcome(
        controlTransaction(contender.db, async (waiting) => {
          await waiting.execute(sql`SELECT id FROM api_keys WHERE id = ${keyId} FOR UPDATE`);
          capturedAt = await databaseTime(waiting);
          const result = await waiting.execute(sql`SELECT
          ${capturedAt}::timestamptz > ${releasedAt}::timestamptz AS after_release,
          transaction_timestamp() < ${releasedAt}::timestamptz AS began_before_release,
          ${capturedAt}::timestamptz::text = ${capturedAt} AS canonical_text,
          rate_admissions = ARRAY['2026-10-05 12:00:00.123456+00'::timestamptz] AS saw_committed
          FROM api_keys WHERE id = ${keyId}`);
          expect(result.rows[0]).toEqual({
            after_release: true,
            began_before_release: true,
            canonical_text: true,
            saw_committed: true,
          });
        }),
      );
      await blockedBy(waiter, blocker);
      expect(capturedAt).toBe("");
      releasedAt = await databaseTime(tx);
    });
    expect(await pending).toBeNull();
    expect(typeof capturedAt).toBe("string");
    expect(capturedAt).not.toBe("");
  } finally {
    await pending;
  }
});

it("serializes owner NO KEY UPDATE without blocking key-creation FKs or forming an owner-key revocation cycle", async () => {
  const waiter = await backend(contender.db);
  const blocker = await backend(holder.db);
  let pending: Promise<unknown> | undefined;
  let acquiredOwner = false;
  const revocable = await createApiKey(db, { kind: "user", userId: ownerId }, ["search:read"]);
  try {
    await holder.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${ownerId} FOR NO KEY UPDATE`);
      pending = outcome(
        controlTransaction(contender.db, async (waiting) => {
          await waiting.execute(sql`SELECT id FROM users WHERE id = ${ownerId} FOR NO KEY UPDATE`);
          acquiredOwner = true;
        }),
      );
      await blockedBy(waiter, blocker);
      expect(acquiredOwner).toBe(false);
      const created = await createApiKey(db, { kind: "user", userId: ownerId }, ["search:read"]);
      expect(created.data.id).not.toBe(keyId);
      expect(await revokeApiKey(db, { kind: "user", userId: ownerId }, revocable.data.id)).toMatchObject({
        id: revocable.data.id,
        revoked_at: expect.any(String),
      });
      // Settlement holds no key lock, so current-key revocation also completes.
      expect(await revokeApiKey(revoker.db, { kind: "user", userId: ownerId }, keyId)).toMatchObject({
        id: keyId,
        revoked_at: expect.any(String),
      });
    });
    expect(await pending).toBeNull();
    expect(acquiredOwner).toBe(true);
    expect(
      (await db.execute(sql`SELECT revoked_at IS NOT NULL AS revoked FROM api_keys WHERE id = ${keyId}`)).rows,
    ).toEqual([{ revoked: true }]);
  } finally {
    await pending;
  }
});

it("keeps rolling-window and expiry microsecond comparisons in SQL, never Date arrays", async () => {
  await controlTransaction(db, async (tx) => {
    const now = "2026-10-05 12:01:00.123456+00";
    await tx.execute(sql`UPDATE api_keys SET rate_admissions = ARRAY[
      ${now}::timestamptz - interval '60 seconds 1 microsecond',
      ${now}::timestamptz - interval '60 seconds',
      ${now}::timestamptz - interval '60 seconds' + interval '1 microsecond'
    ] WHERE id = ${keyId}`);
    await tx.execute(sql`UPDATE api_keys SET rate_admissions = ARRAY(
      SELECT admission FROM unnest(rate_admissions) AS admission
      WHERE admission > ${now}::timestamptz - interval '60 seconds'
    ) WHERE id = ${keyId}`);
    const retained = await tx.execute(sql`SELECT cardinality(rate_admissions) AS count,
      rate_admissions[1] = '2026-10-05 12:00:00.123457+00'::timestamptz AS exact
      FROM api_keys WHERE id = ${keyId}`);
    expect(retained.rows[0]).toEqual({ count: 1, exact: true });
    await tx.execute(sql`INSERT INTO billing_bindings
      (api_key_id, value_hash, fingerprint_hash, settled_at, expires_at)
      SELECT ${keyId}::uuid, delta::text, 'same-fingerprint', ${now}::timestamptz,
        ${now}::timestamptz + delta * interval '1 microsecond'
      FROM generate_series(-1, 1) AS delta`);
    const active = await tx.execute(sql`SELECT value_hash FROM billing_bindings
      WHERE api_key_id = ${keyId} AND expires_at > ${now}::timestamptz`);
    expect(active.rows).toEqual([{ value_hash: "1" }]);
  });
});

it("rolls back on the 500ms lock timeout, reuses the session, and does not leak local settings", async () => {
  const waiter = await backend(contender.db);
  const blocker = await backend(holder.db);
  const baseline = await settings(contender.db);
  const before = await snapshot();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${ownerId} FOR NO KEY UPDATE`);
      pending = outcome(
        controlTransaction(contender.db, async (waiting) => {
          expect(await settings(waiting)).toEqual({
            lock: "500ms",
            transaction: "1500ms",
            statement: baseline.statement,
          });
          await writeAccounting(waiting);
          await waiting.execute(sql`SELECT id FROM users WHERE id = ${ownerId} FOR NO KEY UPDATE`);
        }),
      );
      await blockedBy(waiter, blocker);
      expect(await pending).toMatchObject({ cause: { code: "55P03" } });
    });
    expect(await snapshot()).toBe(before);
    expect(await backend(contender.db)).toBe(waiter);
    expect(await settings(contender.db)).toEqual(baseline);
    await controlTransaction(contender.db, async (tx) => {
      expect(await settings(tx)).toEqual({ lock: "500ms", transaction: "1500ms", statement: baseline.statement });
      await writeAccounting(tx);
    });
    expect(await settings(contender.db)).toEqual(baseline);
    expect((await db.execute(sql`SELECT count FROM monthly_usage`)).rows).toEqual([{ count: 9 }]);
  } finally {
    await pending;
  }
});

it("kills a transaction at 1500ms, rolls back all writes, and recovers the pool with unchanged limits", async () => {
  const previousPid = await backend(contender.db);
  const baseline = await settings(contender.db);
  const before = await snapshot();
  let timeoutError: unknown;
  const error = await outcome(
    controlTransaction(contender.db, async (tx) => {
      expect(await settings(tx)).toEqual({ lock: "500ms", transaction: "1500ms", statement: baseline.statement });
      await writeAccounting(tx);
      // Deliberate workload: the server transaction deadline must beat the 2s statement/client limits.
      try {
        await tx.execute(sql`SELECT pg_sleep(1.8)`);
      } catch (failure) {
        timeoutError = failure;
        throw failure;
      }
    }),
  );
  // Drizzle's attempted ROLLBACK on a dead connection may replace the original error.
  expect(timeoutError).toMatchObject({ cause: { code: "25P04" } });
  expect(error).not.toBeNull();
  expect(await snapshot()).toBe(before);
  expect(await backend(contender.db)).not.toBe(previousPid);
  expect(await settings(contender.db)).toEqual(baseline);
  await controlTransaction(contender.db, async (tx) => {
    expect(await settings(tx)).toEqual({ lock: "500ms", transaction: "1500ms", statement: baseline.statement });
    await writeAccounting(tx);
  });
  expect(await settings(contender.db)).toEqual(baseline);
  expect((await db.execute(sql`SELECT count FROM monthly_usage`)).rows).toEqual([{ count: 9 }]);
});
