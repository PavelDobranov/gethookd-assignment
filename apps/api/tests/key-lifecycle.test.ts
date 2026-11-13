import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { createDatabase } from "../src/db/client.js";
import { apiKeys, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_key_lifecycle";
const connection = createDatabase(url.href);
const { db } = connection;
let ownerId: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_key_lifecycle`);
    await admin.db.execute(sql`CREATE DATABASE gethookd_key_final_upgrade`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});
afterAll(connection.close);
beforeEach(async () => {
  await db.execute(sql`TRUNCATE api_keys, users CASCADE`);
  const [owner] = await db.insert(users).values({ username: "owner", passwordHash: "test-hash" }).returning();
  ownerId = owner.id;
});

it.each(["prefix", "scopes", "created_at"])("requires recorded %s", async (column) => {
  const row = {
    id: randomUUID(),
    user_id: ownerId,
    key_hash: "test-hash",
    prefix: "test-fixture",
    scopes: ["search:read"],
    created_at: "2026-10-05T12:00:00Z",
    [column]: null,
  };
  await expect(
    db.execute(
      sql`INSERT INTO api_keys SELECT * FROM jsonb_populate_record(NULL::api_keys, ${JSON.stringify(row)}::jsonb)`,
    ),
  ).rejects.toMatchObject({ cause: { code: "23502", column } });
});

it.each(
  [[], ["unknown"], ["search:read", "search:read"], ["keys:manage", "search:read"], ["search:read", null], [null]].map(
    (scopes) => ({ scopes }),
  ),
)("rejects noncanonical stored scopes (case %#)", async ({ scopes }) => {
  await expect(
    db.execute(sql`INSERT INTO api_keys (user_id, key_hash, prefix, scopes)
      VALUES (${ownerId}, 'test-hash', 'test-fixture', ${sql.param(scopes)}::text[])`),
  ).rejects.toMatchObject({ cause: { code: "23514", constraint: "api_keys_scopes_check" } });
});

it.each([["search:read"], ["keys:manage"], ["search:read", "keys:manage"]].map((scopes) => ({ scopes })))(
  "accepts canonical scope selection without default elevation (case %#)",
  async ({ scopes }) => {
    await db.execute(sql`INSERT INTO api_keys (user_id, key_hash, prefix, scopes)
      VALUES (${ownerId}, 'test-hash', 'test-fixture', ${sql.param(scopes)}::text[])`);
    const [key] = await db.select().from(apiKeys);
    expect(key.scopes).toEqual(scopes);
    expect(key.lastUsedAt).toBeNull();
    expect(key.revokedAt).toBeNull();
  },
);

it("does not default missing scopes", async () => {
  await expect(
    db.execute(sql`INSERT INTO api_keys (user_id, key_hash, prefix)
    VALUES (${ownerId}, 'test-hash', 'test-fixture')`),
  ).rejects.toMatchObject({ cause: { code: "23502", column: "scopes" } });
});

it("finalizes staged metadata without changing recorded values, including microseconds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gethookd-final-keys-"));
  const upgradeUrl = new URL(url);
  upgradeUrl.pathname = "/gethookd_key_final_upgrade";
  const upgrade = createDatabase(upgradeUrl.href);
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const entries = journal.entries.slice(0, 4);
    await mkdir(join(directory, "meta"));
    await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      await writeFile(join(directory, `${entry.tag}.sql`), await readFile(`drizzle/${entry.tag}.sql`));
    }
    await migrate(upgrade.db, { migrationsFolder: directory });
    await upgrade.db.insert(users).values({ id: ownerId, username: "staged-owner", passwordHash: "test-hash" });
    await upgrade.db.insert(apiKeys).values(apiKeyFixture(ownerId, "preserved-hash"));
    await upgrade.db.execute(sql`UPDATE api_keys SET scopes = ARRAY['keys:manage'],
      created_at = '2026-10-05T12:00:00.123456Z', last_used_at = '2026-10-06T12:00:00.234567Z',
      revoked_at = '2026-10-07T12:00:00.345678Z'`);
    const snapshot = async () =>
      (await upgrade.db.execute(sql`SELECT row_to_json(api_keys)::text AS row FROM api_keys ORDER BY id`)).rows;
    const before = await snapshot();
    await migrate(upgrade.db, { migrationsFolder: "drizzle" });
    expect(await snapshot()).toEqual(before);
    await migrate(upgrade.db, { migrationsFolder: "drizzle" });
    expect(await snapshot()).toEqual(before);
  } finally {
    await upgrade.close();
    await rm(directory, { recursive: true, force: true });
  }
});
