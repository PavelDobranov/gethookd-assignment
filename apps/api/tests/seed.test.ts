import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { hashApiKey, validateApiKey } from "../src/api-keys/index.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { createDatabase } from "../src/db/client.js";
import { generateFixtures } from "../src/db/fixtures.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { seedDatabase, seedDemoUser } from "../src/db/seed.js";
import { seedWorld } from "../src/db/seed-world.js";

// A separate database keeps this suite independent of the empty-DB migration tests.
const admin = createDatabase(inject("postgresUrl"));
const seedUrl = new URL(inject("postgresUrl"));
seedUrl.pathname = "/gethookd_seed_test";
const { db, close } = createDatabase(seedUrl.href);

beforeAll(async () => {
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_seed_test`);
    await admin.db.execute(sql`CREATE DATABASE gethookd_seed_unmigrated`);
    await admin.db.execute(sql`CREATE DATABASE gethookd_initialize_test`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});

beforeEach(async () => {
  // Only this suite's database in the disposable test project is touched.
  await db.execute(sql`TRUNCATE api_keys, ads, brands, users`);
});
afterAll(close);

it("initializes an empty database then preserves changed credentials and unrelated data on replay", async () => {
  const url = new URL(seedUrl);
  url.pathname = "/gethookd_initialize_test";
  const connection = createDatabase(url.href);
  const initialize = () =>
    run("npm", ["run", "db:initialize"], {
      env: { ...process.env, DATABASE_URL: url.href },
      timeout: 8000,
    });
  try {
    await initialize();
    expect((await connection.db.select({ id: ads.id }).from(ads)).length).toBe(20_000);
    expect((await connection.db.select().from(brands)).length).toBe(300);
    const [demo] = await connection.db.select().from(users);
    expect(await validateApiKey(connection.db, "gethookd-public-demo-api-key-m2")).toEqual({ userId: demo.id });
    expect(demo.username).toBe("demo");
    expect(await verifyPassword("demo-password", demo.passwordHash)).toBe(true);
    await connection.db
      .update(users)
      .set({ passwordHash: await hashPassword("changed-password") })
      .where(eq(users.id, demo.id));
    await connection.db.insert(users).values({ username: "unrelated", passwordHash: "test-hash" });
    const before = await connection.db.select().from(users).orderBy(users.username);
    await initialize();
    const after = await connection.db.select().from(users).orderBy(users.username);
    expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
    expect(
      (await connection.db.execute(sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`)).rows,
    ).toEqual(
      readMigrationFiles({ migrationsFolder: "drizzle" }).map(({ hash, folderMillis }) => ({
        hash,
        created_at: String(folderMillis),
      })),
    );
  } finally {
    await connection.close();
  }
}, 20000);

const run = promisify(execFile);
function runSeed(databaseUrl = seedUrl.href) {
  return run("npm", ["run", "db:seed"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 8000,
  });
}

it("runs the seed command twice, closes connections and preserves the ID/hash", async () => {
  const first = await runSeed();
  const [before] = await db.select().from(users);
  expect(before?.username).toBe("demo");
  const second = await runSeed();
  const records = await db.select().from(users);
  expect(records).toHaveLength(1);
  expect(records[0].id).toBe(before.id);
  expect(records[0].passwordHash === before.passwordHash).toBe(true);
  expect((await db.select({ id: ads.id }).from(ads)).length).toBe(20_000);
  expect((await db.select().from(brands)).length).toBe(300);
  expect(await validateApiKey(db, "gethookd-public-demo-api-key-m2")).toEqual({
    userId: before.id,
  });
  for (const output of [first, second]) {
    expect(output.stdout).toContain("Database seed completed.");
    expect(output.stderr).toBe("");
    expect(output.stdout.includes(before.passwordHash)).toBe(false);
    expect(output.stdout.includes("demo-password")).toBe(false);
  }
}, 20000);

it("exits promptly with a safe actionable error on an unmigrated database", async () => {
  const emptyUrl = new URL(seedUrl);
  emptyUrl.pathname = "/gethookd_seed_unmigrated";
  await expect(runSeed(emptyUrl.href)).rejects.toMatchObject({
    code: 1,
    killed: false,
    stderr: expect.stringContaining(
      "Database seeding failed. Check database configuration and apply committed migrations first.",
    ),
  });
}, 10000);

it("rolls back the entire command seed and sanitizes a late persistence failure", async () => {
  await db.execute(sql`CREATE FUNCTION reject_seed_key() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private-key-failure-sentinel'; END $$`);
  await db.execute(sql`CREATE TRIGGER reject_seed_key BEFORE INSERT ON api_keys
    FOR EACH ROW EXECUTE FUNCTION reject_seed_key()`);
  try {
    const failure: unknown = await runSeed().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 1,
      killed: false,
      stdout: expect.not.stringContaining("Database seed completed."),
      stderr: expect.stringContaining("Database seeding failed."),
    });
    expect(failure).not.toMatchObject({
      stderr: expect.stringContaining("private-key-failure-sentinel"),
    });
    expect(failure).not.toMatchObject({
      stderr: expect.stringContaining("gethookd-public-demo-api-key-m2"),
    });
    for (const table of [users, brands, ads, apiKeys]) {
      expect(await db.select().from(table)).toEqual([]);
    }
  } finally {
    await db.execute(sql`DROP TRIGGER reject_seed_key ON api_keys`);
    await db.execute(sql`DROP FUNCTION reject_seed_key()`);
  }
}, 20000);

it("reports invalid configuration without exposing its value", async () => {
  await expect(runSeed("invalid-private-connection-value")).rejects.toMatchObject({
    code: 1,
    killed: false,
    stderr: expect.not.stringContaining("invalid-private-connection-value"),
  });
}, 10000);

it("seeds an empty migrated database with a salted demo password hash", async () => {
  await seedDemoUser(db);
  const records = await db.select().from(users);
  expect(records).toHaveLength(1);
  const [user] = records;
  expect(user.username).toBe("demo");
  expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(user.passwordHash.startsWith("scrypt$")).toBe(true);
  expect(await verifyPassword("demo-password", user.passwordHash)).toBe(true);
  expect(await verifyPassword("wrong-password", user.passwordHash)).toBe(false);
});

it("preserves the exact existing demo ID and hash on repeat seeding", async () => {
  await seedDemoUser(db);
  const [before] = await db.select().from(users);
  await seedDemoUser(db);
  const records = await db.select().from(users);
  expect(records).toHaveLength(1);
  expect(records[0].id).toBe(before.id);
  expect(records[0].passwordHash === before.passwordHash).toBe(true);
});

it("preserves deliberately changed demo credentials and unrelated users", async () => {
  await seedDemoUser(db);
  const changedHash = await hashPassword("deliberately-changed-password");
  await db.update(users).set({ passwordHash: changedHash }).where(eq(users.username, "demo"));
  await db.insert(users).values({ username: "unrelated", passwordHash: "unrelated-test-hash" });
  const before = await db.select().from(users).orderBy(users.username);
  await seedDemoUser(db);
  const after = await db.select().from(users).orderBy(users.username);
  // Compare without printing stored hashes if this assertion fails.
  expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
  const demo = after.find((user) => user.username === "demo");
  expect(demo).toBeDefined();
  expect(await verifyPassword("deliberately-changed-password", demo?.passwordHash ?? "")).toBe(true);
  expect(await verifyPassword("demo-password", demo?.passwordHash ?? "")).toBe(false);
});

it("seeds the complete world and a hash-only key owned by the existing demo user", async () => {
  await db.insert(users).values({ username: "demo", passwordHash: "existing-hash" });
  const [demo] = await db.select().from(users);
  const batchTimings: number[] = [];
  const batchParameters: unknown[][] = [];
  const client = await db.$client.connect();
  const originalQuery = client.query;
  const query = vi.spyOn(client, "query").mockImplementation(
    new Proxy(originalQuery, {
      apply(target, receiver, args) {
        const started = performance.now();
        const result = Reflect.apply(target, receiver, args);
        if (args[0]?.text?.startsWith('insert into "ads"')) {
          batchParameters.push(args[1]);
          return result.finally(() => batchTimings.push(performance.now() - started));
        }
        return result;
      },
    }),
  );
  client.release();
  try {
    await seedDatabase(db);
  } finally {
    query.mockRestore();
  }
  expect(batchTimings).toHaveLength(40);
  // Keep bulk SQL construction bounded: one JSON payload, not 6,000 bindings.
  expect(batchParameters).toHaveLength(40);
  for (const parameters of batchParameters) {
    expect(parameters).toHaveLength(1);
    expect(JSON.parse(String(parameters[0]))).toHaveLength(500);
  }
  console.info(
    `[seed] 40 batches of 500 ads: total SQL ${batchTimings.reduce((sum, ms) => sum + ms, 0).toFixed(0)}ms, slowest ${Math.max(...batchTimings).toFixed(0)}ms`,
  );
  expect((await db.select().from(brands)).length).toBe(300);
  expect((await db.select().from(ads)).length).toBe(20_000);
  expect(await validateApiKey(db, "gethookd-public-demo-api-key-m2")).toEqual({
    userId: demo.id,
  });
  expect(await db.select().from(apiKeys)).toEqual([
    {
      id: expect.any(String),
      userId: demo.id,
      keyHash: hashApiKey("gethookd-public-demo-api-key-m2"),
    },
  ]);
  expect(JSON.stringify(await db.select().from(users)) === JSON.stringify([demo])).toBe(true);
});

it("preserves changed world rows and keys while restoring missing fixture IDs on repeat seed", async () => {
  await seedDatabase(db);
  const fixtures = generateFixtures();
  const first = fixtures.ads[0];
  const missing = fixtures.ads[1];
  await db.update(brands).set({ name: "Changed brand" }).where(eq(brands.id, first.brandId));
  await db.update(ads).set({ headline: "Changed headline", impressionRank: 999 }).where(eq(ads.id, first.id));
  await db.delete(ads).where(eq(ads.id, missing.id));
  await db.delete(ads).where(eq(ads.brandId, 300));
  await db.delete(brands).where(eq(brands.id, 300));
  const [changed] = await db.select().from(ads).where(eq(ads.id, first.id));
  const keysBefore = await db.select().from(apiKeys);
  await seedDatabase(db);
  expect(await db.select().from(ads).where(eq(ads.id, first.id))).toEqual([changed]);
  expect(await db.select().from(ads).where(eq(ads.id, missing.id))).toEqual([missing]);
  expect(await db.select().from(brands).where(eq(brands.id, first.brandId))).toEqual([
    { id: first.brandId, name: "Changed brand" },
  ]);
  expect(await db.select().from(brands).where(eq(brands.id, 300))).toEqual([fixtures.brands[299]]);
  expect(await db.select().from(apiKeys)).toEqual(keysBefore);
  expect((await db.select().from(ads)).length).toBe(20_000);
});

it("round-trips a partial batch with quoted Unicode text, arrays, nulls and offset timestamps", async () => {
  const fixtures = generateFixtures();
  const batch = {
    brands: fixtures.brands.slice(0, 3),
    ads: fixtures.ads.slice(0, 3).map((ad, index) => ({
      ...ad,
      headline: `猫 'quoted' "double" \\ path ${index}`,
      bodyText: "Line one\nLine two\t%_",
      countries: index === 0 ? [] : ["US", "GB", "JP"],
      discoveredAt: new Date("2026-10-05T01:23:45.678+05:30"),
    })),
  };
  await db.transaction((tx) => seedWorld(tx, batch));
  expect(await db.select().from(ads).orderBy(ads.id)).toEqual(batch.ads);
});

it("repairs an occupied missing-fixture rank above both existing and full-fixture maxima", async () => {
  const fixtures = generateFixtures();
  const ranked = fixtures.ads.find((ad) => ad.impressionRank !== null);
  if (!ranked || ranked.impressionRank === null) throw new Error("Expected ranked fixture");
  const occupied = { ...ranked, id: "ingest-shaped-ad" };
  const brandFixtures = {
    brands: fixtures.brands.filter((brand) => brand.id === ranked.brandId),
    ads: fixtures.ads.filter((ad) => ad.brandId === ranked.brandId),
  };
  await db.insert(brands).values(brandFixtures.brands);
  await db.insert(ads).values(occupied);
  await db.transaction((tx) => seedWorld(tx, brandFixtures));
  const [repaired] = await db.select().from(ads).where(eq(ads.id, ranked.id));
  const maximum = Math.max(
    ...fixtures.ads.filter((ad) => ad.brandId === ranked.brandId).map((ad) => ad.impressionRank ?? 0),
  );
  expect(repaired.impressionRank).toBe(maximum + 1);
  expect(await db.select().from(ads).where(eq(ads.id, occupied.id))).toEqual([occupied]);
  await db.transaction((tx) => seedWorld(tx, brandFixtures));
  expect(await db.select().from(ads).where(eq(ads.id, ranked.id))).toEqual([repaired]);
});

it.each([
  { countries: null },
  { countries: "US" },
  { countries: ["US", "XX"] },
  { countries: ["us"] },
  { countries: [42] },
])("rejects invalid country arrays before world persistence (case %#)", async ({ countries }) => {
  const fixtures = generateFixtures();
  Object.assign(fixtures.ads[0], { countries });
  await expect(db.transaction((tx) => seedWorld(tx, fixtures))).rejects.toThrow("Invalid fixture countries.");
  expect(await db.select().from(brands)).toEqual([]);
  expect(await db.select().from(ads)).toEqual([]);
});
