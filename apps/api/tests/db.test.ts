import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { createDatabase } from "../src/db/client.js";
import { users } from "../src/db/schema.js";

const { db, close } = createDatabase(inject("postgresUrl"));
const run = promisify(execFile);

async function migrate() {
  // npm scripts resolve only the installed workspace-local Drizzle Kit binary.
  await run("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: inject("postgresUrl") },
    timeout: 15000,
  });
}

beforeAll(async () => {
  const result = await db.execute(
    sql`SELECT to_regclass('public.users') AS name`,
  );
  expect(result.rows).toEqual([{ name: null }]);
  await migrate();
}, 20000);

afterAll(close);

it("round-trips parameterized user data and keeps the ID stable on updates", async () => {
  const username = "test'; DROP TABLE users; --";
  const [created] = await db
    .insert(users)
    .values({ username, passwordHash: "opaque-test-hash" })
    .returning();
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    await db.select().from(users).where(eq(users.username, username)),
  ).toEqual([created]);
  const [updated] = await db
    .update(users)
    .set({ passwordHash: "replacement-test-hash" })
    .where(eq(users.id, created.id))
    .returning();
  expect(updated).toEqual({
    ...created,
    passwordHash: "replacement-test-hash",
  });
});

it("reapplying committed migrations preserves both users and the migration ledger", async () => {
  const before = await db.select().from(users);
  const ledger = await db.execute(
    sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
  expect(ledger.rows).toHaveLength(1);
  await migrate();
  expect(await db.select().from(users)).toEqual(before);
  expect(
    (
      await db.execute(
        sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
      )
    ).rows,
  ).toEqual(ledger.rows);
}, 20000);
