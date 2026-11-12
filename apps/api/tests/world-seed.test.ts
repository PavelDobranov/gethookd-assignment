import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { isCountryCode, niches } from "../src/ads/index.js";
import { createDatabase } from "../src/db/client.js";
import { generateFixtures } from "../src/db/fixtures.js";
import { ads, brands } from "../src/db/schema.js";
import { seedDatabase } from "../src/db/seed.js";

// Both databases belong exclusively to the disposable PostgreSQL test server.
const postgresUrl = inject("postgresUrl");
const connections = ["gethookd_world_seed_a", "gethookd_world_seed_b"].map(
  (name) => {
    const url = new URL(postgresUrl);
    url.pathname = `/${name}`;
    return { name, ...createDatabase(url.href) };
  },
);
const [first, second] = connections;

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
