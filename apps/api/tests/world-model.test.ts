import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { generateFixtures } from "../src/db/fixtures.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { seedWorld } from "../src/db/seed-world.js";

const worldUrl = new URL(inject("postgresUrl"));
worldUrl.pathname = "/gethookd_world_test";
const { db, close } = createDatabase(worldUrl.href);
const ownerId = "00000000-0000-0000-0000-000000000001";
let adNumber = 0;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_world_test`);
    await admin.db.execute(sql`CREATE DATABASE gethookd_world_upgrade`);
    await admin.db.execute(sql`CREATE DATABASE gethookd_key_upgrade`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(close);
beforeEach(async () => {
  // Only this suite's database in the disposable test project is touched.
  await db.execute(sql`TRUNCATE api_keys, ads, brands, users`);
  await db.execute(sql`INSERT INTO brands (id, name) VALUES (1, 'First'), (2, 'Second')`);
  await db.insert(users).values({ id: ownerId, username: "owner", passwordHash: "test-hash" });
});

function insertAd(overrides: Record<string, unknown> = {}) {
  const record = {
    id: `test-ad-${++adNumber}`,
    brand_id: 1,
    headline: "A serum headline",
    body_text: "A searchable body",
    niche: "skincare",
    format: "image",
    status: "active",
    start_date: "2026-10-04",
    end_date: null,
    impression_rank: null,
    countries: ["US", "GB"],
    discovered_at: "2026-10-05T12:34:56Z",
    ...overrides,
  };
  return db.execute(sql`
    INSERT INTO ads (id, brand_id, headline, body_text, niche, format, status,
      start_date, end_date, impression_rank, countries, discovered_at)
    SELECT id, brand_id, headline, body_text, niche, format, status,
      start_date, end_date, impression_rank, countries, discovered_at
    FROM jsonb_populate_record(NULL::ads, ${JSON.stringify(record)}::jsonb)
    RETURNING *
  `);
}

it("defaults insertion provenance to the top-level transaction even inside a savepoint and preserves it on updates", async () => {
  await db.transaction(async (tx) => {
    const {
      rows: [transaction],
    } = await tx.execute(sql`SELECT pg_current_xact_id()::text AS xid`);
    await tx.transaction(async (nested) => {
      await nested.insert(ads).values(generateFixtures().ads[0]);
      const {
        rows: [stored],
      } = await nested.execute(sql`SELECT inserted_xid::text AS xid FROM ads`);
      expect(stored.xid).toBe(transaction.xid);
      expect(typeof stored.xid).toBe("string");
    });
    await tx.execute(sql`UPDATE ads SET status = 'inactive', end_date = start_date`);
    expect((await tx.execute(sql`SELECT inserted_xid::text AS xid FROM ads`)).rows).toEqual([transaction]);
  });
  await expect(db.execute(sql`UPDATE ads SET inserted_xid = NULL`)).rejects.toMatchObject({
    cause: { code: "23502", column: "inserted_xid" },
  });
});

it("has only the intended storage columns and PostgreSQL identity/date/array types", async () => {
  const result = await db.execute(sql`
    SELECT table_name, column_name, udt_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('brands', 'ads', 'api_keys')
    ORDER BY table_name, ordinal_position
  `);
  expect(result.rows).toEqual([
    ...[
      ["id", "text"],
      ["brand_id", "int4"],
      ["headline", "text"],
      ["body_text", "text"],
      ["niche", "text"],
      ["format", "text"],
      ["status", "text"],
      ["start_date", "date"],
      ["end_date", "date"],
      ["impression_rank", "int4"],
      ["countries", "_text"],
      ["discovered_at", "timestamptz"],
      ["inserted_xid", "xid8"],
    ].map(([column_name, udt_name]) => ({
      table_name: "ads",
      column_name,
      udt_name,
    })),
    ...[
      ["id", "uuid"],
      ["user_id", "uuid"],
      ["key_hash", "text"],
      ["prefix", "text"],
      ["scopes", "_text"],
      ["created_at", "timestamptz"],
      ["last_used_at", "timestamptz"],
      ["revoked_at", "timestamptz"],
    ].map(([column_name, udt_name]) => ({
      table_name: "api_keys",
      column_name,
      udt_name,
    })),
    ...[
      ["id", "int4"],
      ["name", "text"],
    ].map(([column_name, udt_name]) => ({
      table_name: "brands",
      column_name,
      udt_name,
    })),
  ]);
});

it("round-trips domain fixtures through Drizzle and preserves all world records on migration replay", async () => {
  const ad = generateFixtures().ads[0];
  const [stored] = await db.insert(ads).values(ad).returning();
  expect(stored).toEqual({ ...ad, insertedXid: expect.stringMatching(/^\d+$/) });
  const keysBefore = await db.insert(apiKeys).values({ userId: ownerId, keyHash: "round-trip-hash" }).returning();
  const brandsBefore = await db.select().from(brands).orderBy(brands.id);
  const usersBefore = await db.select().from(users);
  await migrate(db, { migrationsFolder: "drizzle" });
  expect(await db.select().from(ads)).toEqual([stored]);
  expect(await db.select().from(apiKeys)).toEqual(keysBefore);
  expect(await db.select().from(brands).orderBy(brands.id)).toEqual(brandsBefore);
  expect(JSON.stringify(await db.select().from(users)) === JSON.stringify(usersBefore)).toBe(true);
});

it.each(["id", "name"])("rejects NULL brands.%s", async (column) => {
  const id = column === "id" ? null : 3;
  const name = column === "name" ? null : "Third";
  await expect(db.execute(sql`INSERT INTO brands (id, name) VALUES (${id}, ${name})`)).rejects.toMatchObject({
    cause: { code: "23502", column },
  });
});

it("rejects duplicate brand IDs and non-integer brand identities", async () => {
  await expect(db.execute(sql`INSERT INTO brands (id, name) VALUES (1, 'Duplicate')`)).rejects.toMatchObject({
    cause: { code: "23505", constraint: "brands_pkey" },
  });
  await expect(db.execute(sql`INSERT INTO brands (id, name) VALUES ('1.5', 'Fractional')`)).rejects.toMatchObject({
    cause: { code: "22P02" },
  });
});

it.each([
  "id",
  "brand_id",
  "headline",
  "body_text",
  "niche",
  "format",
  "status",
  "start_date",
  "countries",
  "discovered_at",
])("rejects NULL ads.%s", async (column) => {
  await expect(insertAd({ [column]: null })).rejects.toMatchObject({
    cause: { code: "23502", column },
  });
});

it("rejects duplicate ad identities and orphaned brands", async () => {
  await insertAd({ id: "duplicate-ad" });
  await expect(insertAd({ id: "duplicate-ad" })).rejects.toMatchObject({
    cause: { code: "23505", constraint: "ads_pkey" },
  });
  await expect(insertAd({ brand_id: 999 })).rejects.toMatchObject({
    cause: { code: "23503" },
  });
  await expect(db.execute(sql`DELETE FROM brands WHERE id = 1`)).rejects.toMatchObject({ cause: { code: "23503" } });
});

it.each([
  ["niche", "unknown", "ads_niche_check"],
  ["niche", "Skincare", "ads_niche_check"],
  ["format", "audio", "ads_format_check"],
  ["format", "Image", "ads_format_check"],
  ["status", "paused", "ads_status_check"],
  ["status", "Active", "ads_status_check"],
  ["impression_rank", 0, "ads_impression_rank_check"],
  ["impression_rank", -1, "ads_impression_rank_check"],
])("rejects ads.%s = %s", async (column, value, constraint) => {
  await expect(insertAd({ [column]: value })).rejects.toMatchObject({
    cause: { code: "23514", constraint },
  });
});

it.each([
  { status: "active", end_date: "2026-10-05" },
  { status: "inactive", end_date: null },
])("rejects inconsistent status/end date $status/$end_date", async (overrides) => {
  await expect(insertAd(overrides)).rejects.toMatchObject({
    cause: { code: "23514", constraint: "ads_status_end_date_check" },
  });
});

it("rejects end dates before start dates and malformed calendar dates/ranks", async () => {
  await expect(insertAd({ status: "inactive", end_date: "2026-10-03" })).rejects.toMatchObject({
    cause: { code: "23514", constraint: "ads_date_order_check" },
  });
  await expect(insertAd({ start_date: "2026-02-30" })).rejects.toMatchObject({
    cause: { code: "22008" },
  });
  await expect(insertAd({ impression_rank: 1.5 })).rejects.toMatchObject({
    cause: { code: "22P02" },
  });
});

it("allows all catalog values and inactive dates equal to or after start", async () => {
  const niches = [
    "skincare",
    "haircare",
    "supplements",
    "fitness",
    "pet-supplies",
    "home-decor",
    "kitchen",
    "apparel",
    "jewelry",
    "baby-kids",
    "outdoor",
    "tech-accessories",
  ];
  for (const niche of niches) await insertAd({ niche });
  for (const format of ["image", "video", "carousel"]) await insertAd({ format });
  await insertAd({ status: "inactive", end_date: "2026-10-04" });
  await insertAd({ status: "inactive", end_date: "2026-10-05" });
});

it("allows gaps, multiple nulls and equal cross-brand ranks, but not duplicate brand-local known ranks", async () => {
  await insertAd({ impression_rank: 1 });
  await insertAd({ impression_rank: 3 });
  await insertAd({ impression_rank: null });
  await insertAd({ impression_rank: null });
  await insertAd({ brand_id: 2, impression_rank: 1 });
  await expect(insertAd({ impression_rank: 1 })).rejects.toMatchObject({
    cause: { code: "23505", constraint: "ads_brand_rank_unique" },
  });
});

it("generates UUID key identities, enforces unique hashes and user references, and permits multiple keys per user", async () => {
  const result = await db.execute(
    sql`INSERT INTO api_keys (user_id, key_hash) VALUES (${ownerId}, 'first-hash'), (${ownerId}, 'second-hash') RETURNING id`,
  );
  expect(result.rows).toHaveLength(2);
  for (const { id } of result.rows) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.rows[0].id).not.toBe(result.rows[1].id);
  await expect(
    db.execute(
      sql`INSERT INTO api_keys (id, user_id, key_hash) VALUES (${result.rows[0].id}, ${ownerId}, 'third-hash')`,
    ),
  ).rejects.toMatchObject({
    cause: { code: "23505", constraint: "api_keys_pkey" },
  });
  await expect(
    db.execute(sql`INSERT INTO api_keys (user_id, key_hash) VALUES (${ownerId}, 'first-hash')`),
  ).rejects.toMatchObject({
    cause: { code: "23505", constraint: "api_keys_key_hash_unique" },
  });
  await expect(
    db.execute(
      sql`INSERT INTO api_keys (user_id, key_hash) VALUES ('00000000-0000-0000-0000-000000000099', 'orphan-hash')`,
    ),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await expect(db.execute(sql`DELETE FROM users WHERE id = ${ownerId}`)).rejects.toMatchObject({
    cause: { code: "23503" },
  });
});

it.each(["id", "user_id", "key_hash", "created_at"])("rejects NULL api_keys.%s", async (column) => {
  const record = {
    id: "00000000-0000-0000-0000-000000000002",
    user_id: ownerId,
    key_hash: "hash",
    created_at: "2026-10-05T12:00:00Z",
    [column]: null,
  };
  await expect(
    db.execute(
      sql`INSERT INTO api_keys SELECT * FROM jsonb_populate_record(NULL::api_keys, ${JSON.stringify(record)}::jsonb)`,
    ),
  ).rejects.toMatchObject({ cause: { code: "23502", column } });
});

it("rejects unknown M3 legacy hashes atomically, then truthfully backfills the known fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gethookd-m3-migrations-"));
  const url = new URL(worldUrl);
  url.pathname = "/gethookd_key_upgrade";
  const connection = createDatabase(url.href);
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const entries = journal.entries.slice(0, 3);
    await mkdir(join(directory, "meta"));
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      await writeFile(join(directory, `${entry.tag}.sql`), await readFile(`drizzle/${entry.tag}.sql`));
    }
    await migrate(connection.db, { migrationsFolder: directory });
    await connection.db.insert(users).values({ id: ownerId, username: "legacy-owner", passwordHash: "unchanged" });
    await connection.db.transaction((tx) =>
      seedWorld(tx, {
        brands: generateFixtures().brands.slice(0, 1),
        ads: generateFixtures().ads.slice(0, 1),
      }),
    );
    await connection.db.execute(sql`INSERT INTO api_keys (user_id, key_hash) VALUES
      (${ownerId}, '58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47'),
      (${ownerId}, 'unknown-legacy-hash')`);
    const snapshot = async () => {
      const records = [];
      for (const table of ["users", "brands", "ads", "api_keys", "drizzle.__drizzle_migrations"]) {
        records.push(
          (
            await connection.db.execute(
              sql.raw(
                `SELECT row_to_json(original)::text AS record FROM (SELECT * FROM ${table} ORDER BY id) original`,
              ),
            )
          ).rows,
        );
      }
      return records;
    };
    const before = await snapshot();
    const {
      rows: [originalKey],
    } = await connection.db.execute(sql`
      SELECT id FROM api_keys WHERE key_hash = '58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47'
    `);
    await expect(migrate(connection.db, { migrationsFolder: "drizzle" })).rejects.toMatchObject({
      cause: { message: "Cannot backfill API key prefixes: unsupported legacy keys require human resolution." },
    });
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await connection.db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'api_keys' AND table_schema = 'public' ORDER BY ordinal_position`)
      ).rows,
    ).toEqual(["id", "user_id", "key_hash"].map((column_name) => ({ column_name })));
    await connection.db.execute(sql`DELETE FROM api_keys WHERE key_hash = 'unknown-legacy-hash'`);
    const {
      rows: [lower],
    } = await connection.db.execute(sql`SELECT clock_timestamp() AS time`);
    await migrate(connection.db, { migrationsFolder: "drizzle" });
    const {
      rows: [upper],
    } = await connection.db.execute(sql`SELECT clock_timestamp() AS time`);
    const [key] = await connection.db.select().from(apiKeys);
    expect(key).toEqual({
      id: originalKey.id,
      userId: ownerId,
      keyHash: "58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47",
      prefix: "gethookd-publ",
      scopes: ["search:read", "keys:manage"],
      createdAt: expect.any(Date),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(key.createdAt.getTime()).toBeGreaterThanOrEqual(new Date(String(lower.time)).getTime());
    expect(key.createdAt.getTime()).toBeLessThanOrEqual(new Date(String(upper.time)).getTime());
    expect((await snapshot()).slice(0, 3)).toEqual(before.slice(0, 3));
    await migrate(connection.db, { migrationsFolder: "drizzle" });
    expect(await connection.db.select().from(apiKeys)).toEqual([key]);
  } finally {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("upgrades M1 and a populated M2 database without changing original records or replaying migrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gethookd-m1-migrations-"));
  const upgradeUrl = new URL(worldUrl);
  upgradeUrl.pathname = "/gethookd_world_upgrade";
  const connection = createDatabase(upgradeUrl.href);
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const first = journal.entries[0];
    expect(first.tag).toBe("0000_living_skreet");
    await mkdir(join(directory, "meta"));
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [first] }));
    await writeFile(join(directory, `${first.tag}.sql`), await readFile(`drizzle/${first.tag}.sql`));
    await migrate(connection.db, { migrationsFolder: directory });
    await connection.db.insert(users).values({
      username: "existing-m1-user",
      passwordHash: "preserved-exact-hash",
    });
    const before = await connection.db.select().from(users);
    const oldLedger = await connection.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`);
    expect(oldLedger.rows).toHaveLength(1);
    const m2 = journal.entries[1];
    expect(m2.tag).toBe("0001_lucky_next_avengers");
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [first, m2] }));
    await writeFile(join(directory, `${m2.tag}.sql`), await readFile(`drizzle/${m2.tag}.sql`));
    await migrate(connection.db, { migrationsFolder: directory });
    await connection.db.transaction((tx) => seedWorld(tx, generateFixtures()));
    await connection.db.execute(sql`UPDATE ads SET discovered_at = '2026-10-05T12:00:00.123456Z'
      WHERE id = 'seed-ad-000001'`);
    // Preserve all original values, including timestamp microseconds, in storage.
    const readOriginalAds = () =>
      connection.db.execute(sql`
      SELECT row_to_json(original)::text AS record FROM (
        SELECT id, brand_id, headline, body_text, niche, format, status, start_date,
          end_date, impression_rank, countries, discovered_at FROM ads ORDER BY id
      ) original
    `);
    const originalAds = await readOriginalAds();
    expect(originalAds.rows).toHaveLength(20_000);
    const originalBrands = await connection.db.select().from(brands).orderBy(brands.id);
    const [owner] = before;
    const originalKeys = await connection.db.execute(sql`
      INSERT INTO api_keys (user_id, key_hash)
      VALUES (${owner.id}, '58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47')
      RETURNING id, user_id, key_hash
    `);
    const {
      rows: [lower],
    } = await connection.db.execute(sql`SELECT pg_current_xact_id()::text AS xid`);
    const started = performance.now();
    await migrate(connection.db, { migrationsFolder: "drizzle" });
    console.info(
      `[migration] populated M2 (20,000 ads): ${(performance.now() - started).toFixed(0)}ms; unchanged 2000ms query/statement deadlines`,
    );
    expect(await readOriginalAds()).toMatchObject({ rows: originalAds.rows });
    expect(await connection.db.select().from(brands).orderBy(brands.id)).toEqual(originalBrands);
    expect((await connection.db.execute(sql`SELECT id, user_id, key_hash FROM api_keys`)).rows).toEqual(
      originalKeys.rows,
    );
    const keysAfter = await connection.db.select().from(apiKeys);
    expect(keysAfter).toEqual([
      {
        id: originalKeys.rows[0].id,
        userId: owner.id,
        keyHash: originalKeys.rows[0].key_hash,
        prefix: "gethookd-publ",
        scopes: ["search:read", "keys:manage"],
        createdAt: expect.any(Date),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    const markers = await connection.db.select({ xid: ads.insertedXid }).from(ads);
    expect(markers).toHaveLength(20_000);
    const uniqueMarkers = [...new Set(markers.map(({ xid }) => xid))];
    expect(uniqueMarkers).toHaveLength(1);
    const {
      rows: [upper],
    } = await connection.db.execute(sql`SELECT pg_current_xact_id()::text AS xid`);
    expect(BigInt(uniqueMarkers[0])).toBeGreaterThan(BigInt(lower.xid));
    expect(BigInt(uniqueMarkers[0])).toBeLessThan(BigInt(upper.xid));
    expect(JSON.stringify(await connection.db.select().from(users)) === JSON.stringify(before)).toBe(true);
    const ledger = await connection.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`);
    expect(ledger.rows[0]).toEqual(oldLedger.rows[0]);
    expect(ledger.rows.map(({ hash, created_at }) => ({ hash, created_at }))).toEqual(
      readMigrationFiles({ migrationsFolder: "drizzle" }).map(({ hash, folderMillis }) => ({
        hash,
        created_at: String(folderMillis),
      })),
    );
    expect(
      (
        await connection.db.execute(
          sql`SELECT to_regclass('brands') AS brands, to_regclass('ads') AS ads, to_regclass('api_keys') AS api_keys`,
        )
      ).rows,
    ).toEqual([{ brands: "brands", ads: "ads", api_keys: "api_keys" }]);
    await migrate(connection.db, { migrationsFolder: "drizzle" });
    expect((await connection.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).rows).toEqual(
      ledger.rows,
    );
    expect(JSON.stringify(await connection.db.select().from(users)) === JSON.stringify(before)).toBe(true);
    expect(await readOriginalAds()).toMatchObject({ rows: originalAds.rows });
    expect(await connection.db.select({ xid: ads.insertedXid }).from(ads)).toEqual(markers);
    expect(await connection.db.select().from(apiKeys)).toEqual(keysAfter);
  } finally {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});
