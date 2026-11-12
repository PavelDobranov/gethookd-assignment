import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

it("rejects duplicate usernames and primary keys in PostgreSQL", async () => {
  const [user] = await db
    .insert(users)
    .values({
      username: "unique-user",
      passwordHash: "opaque-test-hash",
    })
    .returning();
  await expect(
    db.insert(users).values({
      username: user.username,
      passwordHash: "different-test-hash",
    }),
  ).rejects.toMatchObject({
    cause: { code: "23505", constraint: "users_username_unique" },
  });
  await expect(
    db.insert(users).values({
      id: user.id,
      username: "different-user",
      passwordHash: "opaque-test-hash",
    }),
  ).rejects.toMatchObject({
    cause: { code: "23505", constraint: "users_pkey" },
  });
});

it.each([
  { id: null, username: "null-id", passwordHash: "hash", column: "id" },
  {
    id: "00000000-0000-0000-0000-000000000001",
    username: null,
    passwordHash: "hash",
    column: "username",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    username: "null-hash",
    passwordHash: null,
    column: "password_hash",
  },
])(
  "rejects SQL NULL for $column",
  async ({ id, username, passwordHash, column }) => {
    await expect(
      db.execute(sql`
    INSERT INTO users (id, username, password_hash)
    VALUES (${id}::uuid, ${username}, ${passwordHash})
  `),
    ).rejects.toMatchObject({ cause: { code: "23502", column } });
  },
);

it("closes its owned pool explicitly", async () => {
  const connection = createDatabase(inject("postgresUrl"));
  try {
    expect((await connection.db.execute(sql`SELECT 1 AS value`)).rows).toEqual([
      { value: 1 },
    ]);
  } finally {
    await connection.close();
  }
  await expect(connection.db.execute(sql`SELECT 1`)).rejects.toMatchObject({
    cause: { message: "Cannot use a pool after calling end on the pool" },
  });
});

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
  await db.insert(users).values({
    username: "migration-preserved-user",
    passwordHash: "preserved-test-hash",
  });
  const before = await db.select().from(users);
  const ledger = await db.execute(
    sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
  expect(
    ledger.rows.map(({ hash, created_at }) => ({ hash, created_at })),
  ).toEqual(
    readMigrationFiles({ migrationsFolder: "drizzle" }).map(
      ({ hash, folderMillis }) => ({ hash, created_at: String(folderMillis) }),
    ),
  );
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
