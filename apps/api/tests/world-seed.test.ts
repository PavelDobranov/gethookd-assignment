import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { isCountryCode, niches } from "../src/ads/index.js";
import { hashPassword } from "../src/auth/password.js";
import { createDatabase } from "../src/db/client.js";
import { generateFixtures } from "../src/db/fixtures.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { seedDatabase } from "../src/db/seed.js";
import { seedWorld } from "../src/db/seed-world.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

// Both databases belong exclusively to the disposable PostgreSQL test server.
const postgresUrl = inject("postgresUrl");
const connections = ["gethookd_world_seed_a", "gethookd_world_seed_b"].map((name) => {
  const url = new URL(postgresUrl);
  url.pathname = `/${name}`;
  return { name, url: url.href, ...createDatabase(url.href) };
});
const [first, second] = connections;
const run = promisify(execFile);

function highestRankedFixture() {
  return generateFixtures()
    .ads.filter((ad) => ad.brandId === 1 && ad.impressionRank !== null)
    .sort((a, b) => (b.impressionRank ?? 0) - (a.impressionRank ?? 0))[0];
}

// PostgreSQL text retains complete records (including timestamp microseconds).
// Assertions compare booleans so stored credential hashes cannot enter failure logs.
async function readRecords() {
  const { rows } = await first.db.execute<{
    table: string;
    id: string;
    record: string;
  }>(sql`
    SELECT 'ads' AS table, id::text, row_to_json(a)::text AS record FROM ads a
    UNION ALL SELECT 'brands', id::text, row_to_json(b)::text FROM brands b
    UNION ALL SELECT 'users', id::text, row_to_json(u)::text FROM users u
    UNION ALL SELECT 'api_keys', id::text, row_to_json(k)::text FROM api_keys k
    UNION ALL SELECT 'monthly_usage', owner_id::text || '/' || period_start::text, row_to_json(m)::text FROM monthly_usage m
    UNION ALL SELECT 'billing_bindings', api_key_id::text || '/' || value_hash, row_to_json(b)::text FROM billing_bindings b
    ORDER BY 1, 2
  `);
  return rows;
}

beforeAll(async () => {
  const admin = createDatabase(postgresUrl);
  try {
    for (const connection of connections) {
      await admin.db.execute(sql.raw(`CREATE DATABASE ${connection.name}`));
      await migrate(connection.db, { migrationsFolder: "drizzle" });
    }
  } finally {
    await admin.close();
  }
});
beforeEach(async () => {
  for (const { db } of connections) {
    await db.execute(sql`TRUNCATE api_keys, ads, brands, users CASCADE`);
    expect(
      (
        await db.execute(sql`SELECT (SELECT count(*)::int FROM monthly_usage) AS usage,
      (SELECT count(*)::int FROM billing_bindings) AS bindings`)
      ).rows,
    ).toEqual([{ usage: 0, bindings: 0 }]);
  }
});
afterAll(async () => {
  await Promise.all(connections.map((connection) => connection.close()));
});

// Keep every original M2 field in deterministic comparisons; transaction
// metadata is checked separately and full records still guard repeat seeding.
const adDomainColumns = {
  id: ads.id,
  brandId: ads.brandId,
  headline: ads.headline,
  bodyText: ads.bodyText,
  niche: ads.niche,
  format: ads.format,
  status: ads.status,
  startDate: ads.startDate,
  endDate: ads.endDate,
  impressionRank: ads.impressionRank,
  countries: ads.countries,
  discoveredAt: ads.discoveredAt,
};

async function readWorld(db: typeof first.db) {
  return {
    brands: await db.select().from(brands).orderBy(brands.id),
    ads: await db.select(adDomainColumns).from(ads).orderBy(ads.id),
  };
}

it("persists identical complete ordered worlds in two independently initialized databases", async () => {
  await seedDatabase(first.db);
  await seedDatabase(second.db);
  const world = await readWorld(first.db);
  expect(await readWorld(second.db)).toEqual(world);
  expect(world).toEqual(generateFixtures());
  for (const { db } of connections) {
    const markers = await db.select({ insertedXid: ads.insertedXid }).from(ads);
    expect(markers).toHaveLength(20_000);
    for (const { insertedXid } of markers) expect(insertedXid).toMatch(/^\d+$/);
    // Seed's explicit-column batches all share one insertion transaction.
    expect(new Set(markers.map(({ insertedXid }) => insertedXid)).size).toBe(1);
  }
  // Password salts and generated user/key UUIDs are intentionally not compared.
  expect(world.brands).toHaveLength(300);
  expect(world.ads).toHaveLength(20_000);
  expect(world.brands.map((brand) => brand.id)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  expect(new Set(world.brands.map((brand) => brand.name)).size).toBe(300);
  expect(world.ads.map((ad) => ad.id)).toEqual(
    Array.from({ length: 20_000 }, (_, i) => `seed-ad-${String(i + 1).padStart(6, "0")}`),
  );
  expect(world.ads.filter((ad) => ad.status === "active")).toHaveLength(12_000);
  expect(world.ads.filter((ad) => ad.impressionRank === null)).toHaveLength(8_000);
  expect(new Set(world.ads.map((ad) => ad.format))).toEqual(new Set(["image", "video", "carousel"]));
  expect(new Set(world.ads.map((ad) => ad.niche))).toEqual(new Set(niches.map((niche) => niche.slug)));
  for (const niche of niches) {
    const headlines = world.ads
      .filter((ad) => ad.niche === niche.slug)
      .map((ad) => ad.headline)
      .join("\n");
    for (const keyword of niche.keywords) expect(headlines).toContain(keyword);
  }
  const starts = world.ads.map((ad) => ad.startDate).sort();
  expect(starts[0]).toBe("2024-10-05");
  expect(starts.at(-1)).toBe("2026-10-04");
  const brandIds = new Set(world.brands.map((brand) => brand.id));
  const ranks = new Map<number, Set<number>>();
  for (const ad of world.ads) {
    expect(brandIds.has(ad.brandId)).toBe(true);
    expect(ad.headline.length).toBeGreaterThan(0);
    expect(ad.bodyText.length).toBeGreaterThan(0);
    expect(ad.countries.length).toBeGreaterThan(0);
    expect(ad.countries.every(isCountryCode)).toBe(true);
    expect(new Set(ad.countries).size).toBe(ad.countries.length);
    expect(new Date(ad.startDate).toISOString().slice(0, 10)).toBe(ad.startDate);
    expect(ad.discoveredAt.toISOString()).toMatch(/^2026-10-05T\d{2}:\d{2}:\d{2}\.000Z$/);
    if (ad.status === "active") {
      expect(ad.endDate).toBeNull();
    } else {
      expect(ad.status).toBe("inactive");
      expect(ad.endDate).not.toBeNull();
      expect(new Date(ad.endDate ?? "").toISOString().slice(0, 10)).toBe(ad.endDate);
      expect(ad.endDate >= ad.startDate).toBe(true);
      expect(ad.endDate <= "2026-10-05").toBe(true);
    }
    if (ad.impressionRank !== null) {
      expect(Number.isInteger(ad.impressionRank)).toBe(true);
      expect(ad.impressionRank).toBeGreaterThan(0);
      const known = ranks.get(ad.brandId) ?? new Set<number>();
      expect(known.has(ad.impressionRank)).toBe(false);
      known.add(ad.impressionRank);
      ranks.set(ad.brandId, known);
    }
  }
  expect(ranks.size).toBe(300);
}, 20000);

it("preserves all evolved records through initialization and seed while restoring occupied highest-rank and null-rank fixtures", async () => {
  const { db } = first;
  await seedDatabase(db);
  const fixtures = generateFixtures();
  const ranked = highestRankedFixture();
  const nullRanked = fixtures.ads.find((ad) => ad.brandId === 1 && ad.impressionRank === null);
  if (!nullRanked || ranked.impressionRank === null) throw new Error("Expected repair fixtures");
  const changed = fixtures.ads.find((ad) => ad.brandId === 2 && ad.status === "active");
  if (!changed) throw new Error("Expected active fixture");
  await db
    .update(users)
    .set({ passwordHash: await hashPassword("changed-world-password") })
    .where(eq(users.username, "demo"));
  const [unrelated] = await db
    .insert(users)
    .values({ username: "unrelated", passwordHash: "test-only-hash" })
    .returning();
  await db.update(apiKeys).set({ userId: unrelated.id });
  await db.insert(apiKeys).values(apiKeyFixture(unrelated.id, "unrelated-key-hash"));
  const [unrelatedKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, "unrelated-key-hash"));
  expect(unrelatedKey).toEqual({
    id: expect.any(String),
    userId: unrelated.id,
    keyHash: "unrelated-key-hash",
    prefix: "test-fixture",
    scopes: ["search:read", "keys:manage"],
    createdAt: expect.any(Date),
    lastUsedAt: null,
    revokedAt: null,
    rateAdmissions: [],
  });
  await db.update(brands).set({ name: "Evolved brand" }).where(eq(brands.id, 2));
  await db
    .update(ads)
    .set({
      headline: "Evolved headline",
      bodyText: "Changed body",
      countries: ["JP", "CA"],
      status: "inactive",
      startDate: "2020-01-01",
      endDate: "2026-10-06",
    })
    .where(eq(ads.id, changed.id));
  await db.delete(ads).where(eq(ads.id, ranked.id));
  await db.delete(ads).where(eq(ads.id, nullRanked.id));
  await db.delete(ads).where(eq(ads.brandId, 300));
  await db.delete(brands).where(eq(brands.id, 300));
  await db.insert(ads).values({
    ...ranked,
    id: "ingest-ad-occupied-highest-rank",
    headline: "Ingest-shaped backdated ad",
    startDate: "2026-09-01",
    status: "active",
    endDate: null,
    discoveredAt: new Date("2026-10-06T12:00:00Z"),
  });
  await db.insert(brands).values({ id: 999, name: "Unrelated brand" });
  await db.insert(ads).values({ ...nullRanked, id: "unrelated-ad", brandId: 999 });
  await db.execute(sql`UPDATE ads SET discovered_at = '2026-10-06T12:00:00.123456Z'
    WHERE id = 'ingest-ad-occupied-highest-rank'`);
  await db.execute(sql`INSERT INTO monthly_usage VALUES (${unrelated.id}, '2028-02-01', 12)`);
  await db.execute(sql`INSERT INTO billing_bindings VALUES
    (${unrelatedKey.id}, 'value-hash', 'fingerprint-hash', '2028-02-29T12:00:00.123456Z', '2028-03-01T12:00:00.123456Z')`);
  const before = await readRecords();
  const initialize = await run("npm", ["run", "db:initialize"], {
    env: { ...process.env, DATABASE_URL: first.url },
    timeout: 8000,
  });
  expect(initialize.stderr).toBe("");
  const [repaired] = await db.select(adDomainColumns).from(ads).where(eq(ads.id, ranked.id));
  expect(repaired).toEqual({
    ...ranked,
    impressionRank: ranked.impressionRank + 1,
  });
  expect(await db.select(adDomainColumns).from(ads).where(eq(ads.id, nullRanked.id))).toEqual([nullRanked]);
  expect(await db.select().from(brands).where(eq(brands.id, 300))).toEqual([fixtures.brands[299]]);
  expect(await db.select(adDomainColumns).from(ads).where(eq(ads.brandId, 300)).orderBy(ads.id)).toEqual(
    fixtures.ads.filter((ad) => ad.brandId === 300),
  );
  const restored = new Set([
    `ads:${ranked.id}`,
    `ads:${nullRanked.id}`,
    "brands:300",
    ...fixtures.ads.filter((ad) => ad.brandId === 300).map((ad) => `ads:${ad.id}`),
  ]);
  const after = await readRecords();
  expect(after.length).toBe(before.length + restored.size);
  expect(
    JSON.stringify(after.filter((row) => !restored.has(`${row.table}:${row.id}`))) === JSON.stringify(before),
  ).toBe(true);
  await seedDatabase(db);
  expect(JSON.stringify(await readRecords()) === JSON.stringify(after)).toBe(true);
}, 20000);

it("rolls back earlier world batches and brand inserts on an unexpected uniqueness conflict", async () => {
  const { db } = first;
  const fixtures = generateFixtures();
  await db.insert(brands).values(fixtures.brands[0]);
  await db.insert(ads).values(fixtures.ads[0]);
  // More than one 500-ad batch is missing; fail only in the final batch.
  const missing = {
    brands: fixtures.brands.filter((brand) => brand.id >= 290),
    ads: fixtures.ads.filter((ad) => ad.brandId >= 290),
  };
  expect(missing.ads.length).toBeGreaterThan(500);
  const before = await readRecords();
  await db.execute(sql`CREATE FUNCTION collide_world_id() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.id := 'seed-ad-000001'; RETURN NEW; END $$`);
  await db.execute(sql`CREATE TRIGGER collide_world_id BEFORE INSERT ON ads
    FOR EACH ROW WHEN (NEW.id = 'seed-ad-019800') EXECUTE FUNCTION collide_world_id()`);
  try {
    await expect(db.transaction((tx) => seedWorld(tx, missing))).rejects.toThrow();
    expect(JSON.stringify(await readRecords()) === JSON.stringify(before)).toBe(true);
  } finally {
    await db.execute(sql`DROP TRIGGER collide_world_id ON ads`);
    await db.execute(sql`DROP FUNCTION collide_world_id()`);
  }
}, 20000);

it.each([2_147_483_646, 2_147_483_647])(
  "repairs up to the integer rank limit, but fails with full rollback beyond it (existing maximum %i)",
  async (maximum) => {
    const { db } = first;
    const fixtures = generateFixtures();
    const world = {
      brands: fixtures.brands.filter((brand) => brand.id === 1 || brand.id === 300),
      ads: fixtures.ads.filter((ad) => ad.brandId === 1 || ad.brandId === 300),
    };
    const seed = () => db.transaction((tx) => seedWorld(tx, world));
    await seed();
    const ranked = highestRankedFixture();
    await db.delete(ads).where(eq(ads.id, ranked.id));
    await db.insert(ads).values([
      { ...ranked, id: "ingest-ad-occupying-desired-rank" },
      { ...ranked, id: "ingest-ad-at-column-limit", impressionRank: maximum },
    ]);
    if (maximum === 2_147_483_647) {
      // Brands are inserted before rank allocation: exhaustion must undo them too.
      await db.delete(ads).where(eq(ads.brandId, 300));
      await db.delete(brands).where(eq(brands.id, 300));
    }
    const before = await readRecords();
    if (maximum === 2_147_483_647) {
      await expect(seed()).rejects.toThrow("Fixture rank space exhausted.");
      expect(JSON.stringify(await readRecords()) === JSON.stringify(before)).toBe(true);
    } else {
      await seed();
      const [repaired] = await db.select(adDomainColumns).from(ads).where(eq(ads.id, ranked.id));
      expect(repaired).toEqual({ ...ranked, impressionRank: 2_147_483_647 });
      const after = await readRecords();
      expect(after.length).toBe(before.length + 1);
      expect(
        JSON.stringify(after.filter((row) => !(row.table === "ads" && row.id === ranked.id))) ===
          JSON.stringify(before),
      ).toBe(true);
      await seed();
      expect(JSON.stringify(await readRecords()) === JSON.stringify(after)).toBe(true);
    }
  },
  20000,
);
