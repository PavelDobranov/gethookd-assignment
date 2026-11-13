import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { hashApiKey, validateApiKey, validateApiKeyIdentity } from "../src/api-keys/keys.js";
import { createApiKey, type KeyAuthority, listApiKeys, revokeApiKey } from "../src/api-keys/lifecycle.js";
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

it("issues strong reveal-once credentials and stores only their full hash", async () => {
  const authority: KeyAuthority = { kind: "user", userId: ownerId };
  const first = await createApiKey(db, authority, ["keys:manage", "search:read"]);
  const second = await createApiKey(db, authority, ["search:read"]);
  expect(first.secret).toMatch(/^ghk_[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(first.secret.slice(4), "base64url")).toHaveLength(32);
  expect(first.secret).not.toBe(second.secret);
  expect(first.data).toEqual({
    id: expect.any(String),
    prefix: first.secret.slice(0, 12),
    scopes: ["search:read", "keys:manage"],
    created_at: expect.any(String),
    last_used_at: null,
    revoked_at: null,
  });
  const stored = await db.select().from(apiKeys);
  expect(stored.find((key) => key.id === first.data.id)?.keyHash).toBe(hashApiKey(first.secret));
  expect(JSON.stringify(stored)).not.toContain(first.secret);
  expect(await validateApiKeyIdentity(db, first.secret)).toEqual({
    id: first.data.id,
    userId: ownerId,
    scopes: ["search:read", "keys:manage"],
  });
  expect(await validateApiKeyIdentity(db, first.data.prefix)).toBeNull();
  expect(await validateApiKey(db, first.secret)).toEqual({ userId: ownerId });
  const listed = await listApiKeys(db, authority);
  expect(JSON.stringify(listed)).not.toContain(first.secret);
  expect(JSON.stringify(listed)).not.toContain(hashApiKey(first.secret));
  expect(Object.keys(listed.data[0]).sort()).toEqual([
    "created_at",
    "id",
    "last_used_at",
    "prefix",
    "revoked_at",
    "scopes",
  ]);
});

it.each(
  [undefined, null, [], ["unknown"], ["search:read", "search:read"], "search:read", [null]].map((scopes) => ({
    scopes,
  })),
)("refuses invalid issuance scopes without inserting a row (case %#)", async ({ scopes }) => {
  await expect(createApiKey(db, { kind: "user", userId: ownerId }, scopes)).rejects.toMatchObject({
    code: "INVALID_SCOPES",
  });
  expect(await db.select().from(apiKeys)).toEqual([]);
});

it("enforces manage authority and subset delegation without silently elevating", async () => {
  const portal: KeyAuthority = { kind: "user", userId: ownerId };
  const manager = await createApiKey(db, portal, ["keys:manage"]);
  const managerIdentity = await validateApiKeyIdentity(db, manager.secret);
  if (!managerIdentity) throw new Error("Missing test identity");
  const authority: KeyAuthority = { kind: "api-key", identity: managerIdentity };
  await expect(createApiKey(db, authority, ["search:read"])).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  await expect(createApiKey(db, authority, ["keys:manage", "search:read"])).rejects.toMatchObject({
    code: "INSUFFICIENT_SCOPE",
  });
  expect((await createApiKey(db, authority, ["keys:manage"])).data.scopes).toEqual(["keys:manage"]);
  const reader = await createApiKey(db, portal, ["search:read"]);
  const identity = await validateApiKeyIdentity(db, reader.secret);
  if (!identity) throw new Error("Missing test identity");
  const readerAuthority: KeyAuthority = { kind: "api-key", identity };
  await expect(createApiKey(db, readerAuthority, ["search:read"])).rejects.toMatchObject({
    code: "INSUFFICIENT_SCOPE",
  });
  await expect(listApiKeys(db, readerAuthority)).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
  await expect(revokeApiKey(db, readerAuthority, manager.data.id)).rejects.toMatchObject({
    code: "INSUFFICIENT_SCOPE",
  });
  const both = await createApiKey(db, portal, ["search:read", "keys:manage"]);
  const bothIdentity = await validateApiKeyIdentity(db, both.secret);
  if (!bothIdentity) throw new Error("Missing test identity");
  expect((await createApiKey(db, { kind: "api-key", identity: bothIdentity }, ["search:read"])).data.scopes).toEqual([
    "search:read",
  ]);
});

it("isolates owners and permanently revokes even the caller itself", async () => {
  const [other] = await db.insert(users).values({ username: "other", passwordHash: "test-hash" }).returning();
  const portal: KeyAuthority = { kind: "user", userId: ownerId };
  const key = await createApiKey(db, portal, ["keys:manage"]);
  const identity = await validateApiKeyIdentity(db, key.secret);
  if (!identity) throw new Error("Missing test identity");
  const foreign: KeyAuthority = { kind: "user", userId: other.id };
  expect((await listApiKeys(db, foreign)).data).toEqual([]);
  expect(await revokeApiKey(db, foreign, key.data.id)).toBeNull();
  expect(await revokeApiKey(db, foreign, randomUUID())).toBeNull();
  expect(await validateApiKeyIdentity(db, key.secret)).toEqual(identity);
  const [revoked, concurrent] = await Promise.all([
    revokeApiKey(db, { kind: "api-key", identity }, key.data.id),
    revokeApiKey(db, portal, key.data.id),
  ]);
  expect(revoked?.revoked_at).toEqual(expect.any(String));
  expect(concurrent).toEqual(revoked);
  expect(await validateApiKeyIdentity(db, key.secret)).toBeNull();
  expect(await validateApiKey(db, key.secret)).toBeNull();
  await db.execute(sql`UPDATE api_keys SET revoked_at = '2026-10-07T12:00:00.345678Z' WHERE id = ${key.data.id}`);
  const snapshot = async () => (await db.execute(sql`SELECT row_to_json(api_keys)::text AS row FROM api_keys`)).rows;
  const before = await snapshot();
  await revokeApiKey(db, portal, key.data.id);
  expect(await snapshot()).toEqual(before);
  const listed = await listApiKeys(db, portal);
  expect(listed.data[0].revoked_at).toBe("2026-10-07T12:00:00.345Z");
  expect(listed.data[0].scopes).toEqual(["keys:manage"]);
});

it("paginates all owner keys by creation descending then ID ascending, allowing colliding prefixes", async () => {
  const authority: KeyAuthority = { kind: "user", userId: ownerId };
  const ids = [
    "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
  ];
  for (const id of ids) {
    await db.insert(apiKeys).values({
      ...apiKeyFixture(ownerId, id, "same-prefix!"),
      id,
      createdAt: new Date(id === ids[0] ? "2026-10-06" : "2026-10-05"),
    });
  }
  const first = await listApiKeys(db, authority, { limit: 2 });
  expect(first).toMatchObject({ limit: 2, offset: 0, has_more: true });
  expect(first.data.map((key) => key.id)).toEqual([ids[0], ids[1]]);
  expect((await listApiKeys(db, authority, { limit: 2, offset: 2 })).data.map((key) => key.id)).toEqual([ids[2]]);
  expect(await listApiKeys(db, authority, { offset: 3 })).toEqual({ data: [], limit: 20, offset: 3, has_more: false });
  for (const options of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.1 },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await expect(listApiKeys(db, authority, options)).rejects.toMatchObject({ code: "INVALID_PAGINATION" });
  }
});

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
