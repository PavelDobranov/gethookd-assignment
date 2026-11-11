import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { createDatabase } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { seedDemoUser } from "../src/db/seed.js";

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
  await db.delete(users);
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
    const [demo] = await connection.db.select().from(users);
    expect(demo.username).toBe("demo");
    expect(await verifyPassword("demo-password", demo.passwordHash)).toBe(true);
    await connection.db
      .update(users)
      .set({ passwordHash: await hashPassword("changed-password") })
      .where(eq(users.id, demo.id));
    await connection.db
      .insert(users)
      .values({ username: "unrelated", passwordHash: "test-hash" });
    const before = await connection.db
      .select()
      .from(users)
      .orderBy(users.username);
    await initialize();
    const after = await connection.db
      .select()
      .from(users)
      .orderBy(users.username);
    expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
    expect(
      (
        await connection.db.execute(
          sql`SELECT * FROM drizzle.__drizzle_migrations`,
        )
      ).rows,
    ).toHaveLength(1);
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
  for (const output of [first, second]) {
    expect(output.stdout).toContain("Demo user seed completed.");
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

it("reports invalid configuration without exposing its value", async () => {
  await expect(
    runSeed("invalid-private-connection-value"),
  ).rejects.toMatchObject({
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
  await db
    .update(users)
    .set({ passwordHash: changedHash })
    .where(eq(users.username, "demo"));
  await db
    .insert(users)
    .values({ username: "unrelated", passwordHash: "unrelated-test-hash" });
  const before = await db.select().from(users).orderBy(users.username);
  await seedDemoUser(db);
  const after = await db.select().from(users).orderBy(users.username);
  // Compare without printing stored hashes if this assertion fails.
  expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
  const demo = after.find((user) => user.username === "demo");
  expect(demo).toBeDefined();
  expect(
    await verifyPassword(
      "deliberately-changed-password",
      demo?.passwordHash ?? "",
    ),
  ).toBe(true);
  expect(await verifyPassword("demo-password", demo?.passwordHash ?? "")).toBe(
    false,
  );
});
