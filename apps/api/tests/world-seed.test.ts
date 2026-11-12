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

// Both databases belong exclusively to the disposable PostgreSQL test server.
const postgresUrl = inject("postgresUrl");
const connections = ["gethookd_world_seed_a", "gethookd_world_seed_b"].map(
  (name) => {
    const url = new URL(postgresUrl);
    url.pathname = `/${name}`;
    return { name, url: url.href, ...createDatabase(url.href) };
  },
);
const [first, second] = connections;
const run = promisify(execFile);

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
    await db.execute(sql`TRUNCATE api_keys, ads, brands, users`);
  }
});
afterAll(async () => {
  await Promise.all(connections.map((connection) => connection.close()));
});

async function readWorld(db: typeof first.db) {
  return {
    brands: await db.select().from(brands).orderBy(brands.id),
    ads: await db.select().from(ads).orderBy(ads.id),
  };
}

it("persists identical complete ordered worlds in two independently initialized databases", async () => {
  await seedDatabase(first.db);
  await seedDatabase(second.db);
  const world = await readWorld(first.db);
  expect(await readWorld(second.db)).toEqual(world);
  expect(world).toEqual(generateFixtures());
  // Password salts and generated user/key UUIDs are intentionally not compared.
  expect(world.brands).toHaveLength(300);
  expect(world.ads).toHaveLength(20_000);
  expect(world.brands.map((brand) => brand.id)).toEqual(
    Array.from({ length: 300 }, (_, i) => i + 1),
  );
  expect(new Set(world.brands.map((brand) => brand.name)).size).toBe(300);
  expect(world.ads.map((ad) => ad.id)).toEqual(
    Array.from(
      { length: 20_000 },
      (_, i) => `seed-ad-${String(i + 1).padStart(6, "0")}`,
    ),
  );
  expect(world.ads.filter((ad) => ad.status === "active")).toHaveLength(12_000);
  expect(world.ads.filter((ad) => ad.impressionRank === null)).toHaveLength(
    8_000,
  );
  expect(new Set(world.ads.map((ad) => ad.format))).toEqual(
    new Set(["image", "video", "carousel"]),
  );
  expect(new Set(world.ads.map((ad) => ad.niche))).toEqual(
    new Set(niches.map((niche) => niche.slug)),
  );
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
    expect(new Date(ad.startDate).toISOString().slice(0, 10)).toBe(
      ad.startDate,
    );
    expect(ad.discoveredAt.toISOString()).toMatch(
      /^2026-10-05T\d{2}:\d{2}:\d{2}\.000Z$/,
    );
    if (ad.status === "active") {
      expect(ad.endDate).toBeNull();
    } else {
      expect(ad.status).toBe("inactive");
      expect(ad.endDate).not.toBeNull();
      expect(new Date(ad.endDate ?? "").toISOString().slice(0, 10)).toBe(
        ad.endDate,
      );
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
  const ranked = fixtures.ads
    .filter((ad) => ad.brandId === 1 && ad.impressionRank !== null)
    .sort((a, b) => (b.impressionRank ?? 0) - (a.impressionRank ?? 0))[0];
  const nullRanked = fixtures.ads.find(
    (ad) => ad.brandId === 1 && ad.impressionRank === null,
  );
  if (!nullRanked || ranked.impressionRank === null)
    throw new Error("Expected repair fixtures");
  const changed = fixtures.ads.find(
    (ad) => ad.brandId === 2 && ad.status === "active",
  );
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
  await db
    .insert(apiKeys)
    .values({ userId: unrelated.id, keyHash: "unrelated-key-hash" });
  await db
    .update(brands)
    .set({ name: "Evolved brand" })
    .where(eq(brands.id, 2));
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
  await db
    .insert(ads)
    .values({ ...nullRanked, id: "unrelated-ad", brandId: 999 });
  await db.execute(sql`UPDATE ads SET discovered_at = '2026-10-06T12:00:00.123456Z'
    WHERE id = 'ingest-ad-occupied-highest-rank'`);
  const before = await readRecords();
  const initialize = await run("npm", ["run", "db:initialize"], {
    env: { ...process.env, DATABASE_URL: first.url },
    timeout: 8000,
  });
  expect(initialize.stderr).toBe("");
  const [repaired] = await db.select().from(ads).where(eq(ads.id, ranked.id));
  expect(repaired).toEqual({
    ...ranked,
    impressionRank: ranked.impressionRank + 1,
  });
  expect(await db.select().from(ads).where(eq(ads.id, nullRanked.id))).toEqual([
    nullRanked,
  ]);
  expect(await db.select().from(brands).where(eq(brands.id, 300))).toEqual([
    fixtures.brands[299],
  ]);
  expect(
    await db.select().from(ads).where(eq(ads.brandId, 300)).orderBy(ads.id),
  ).toEqual(fixtures.ads.filter((ad) => ad.brandId === 300));
  const restored = new Set([
    `ads:${ranked.id}`,
    `ads:${nullRanked.id}`,
    "brands:300",
    ...fixtures.ads
      .filter((ad) => ad.brandId === 300)
      .map((ad) => `ads:${ad.id}`),
  ]);
  const after = await readRecords();
  expect(after.length).toBe(before.length + restored.size);
  expect(
    JSON.stringify(
      after.filter((row) => !restored.has(`${row.table}:${row.id}`)),
    ) === JSON.stringify(before),
  ).toBe(true);
  await seedDatabase(db);
  expect(JSON.stringify(await readRecords()) === JSON.stringify(after)).toBe(
    true,
  );
}, 20000);
