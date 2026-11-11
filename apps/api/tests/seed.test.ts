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
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});

beforeEach(async () => {
  await db.delete(users);
});
afterAll(close);

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
