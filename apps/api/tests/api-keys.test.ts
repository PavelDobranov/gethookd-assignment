import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { hashApiKey, validateApiKey } from "../src/api-keys/index.js";
import { createDatabase } from "../src/db/client.js";
import { apiKeys, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_api_keys_test";
const connection = createDatabase(url.href);
const { db } = connection;
const publicKey = "gethookd-public-demo-api-key-m2";
let ownerId: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_api_keys_test`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(connection.close);
beforeEach(async () => {
  // This database belongs exclusively to this suite in the disposable project.
  // Future accounting rows are reset only in this suite's disposable database.
  await db.execute(sql`TRUNCATE api_keys, ads, brands, users CASCADE`);
  const [owner] = await db
    .insert(users)
    .values({ username: "owner", passwordHash: "test-only-hash" })
    .returning({ id: users.id });
  ownerId = owner.id;
  await db.insert(apiKeys).values(apiKeyFixture(ownerId, hashApiKey(publicKey), "gethookd-publ"));
});

it("resolves the actual owning user from a hash-only stored key", async () => {
  expect(await validateApiKey(db, publicKey)).toEqual({ userId: ownerId });
  const [stored] = await db.select().from(apiKeys);
  expect(stored).toEqual({
    id: expect.any(String),
    userId: ownerId,
    keyHash: "58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47",
    prefix: "gethookd-publ",
    scopes: ["search:read", "keys:manage"],
    createdAt: expect.any(Date),
    lastUsedAt: null,
    revokedAt: null,
  });
});

it.each([
  "unknown-key",
  "' OR 1=1 --",
  ` ${publicKey}`,
  `${publicKey} `,
  publicKey.toUpperCase(),
  hashApiKey(publicKey),
])("rejects an unmatched scalar key (case %#)", async (key) => {
  expect(await validateApiKey(db, key)).toBeNull();
});

it.each([undefined, null, "", 42, true, [publicKey], { api_key: publicKey }])(
  "rejects missing, empty and non-scalar input (case %#)",
  async (key) => {
    // Even a stored empty-string digest must not authenticate an empty input.
    await db.insert(apiKeys).values(apiKeyFixture(ownerId, hashApiKey("")));
    expect(await validateApiKey(db, key)).toBeNull();
  },
);

it("observes changed and removed hashes between calls, including previously invalid keys", async () => {
  const replacement = "replacement-test-key";
  expect(await validateApiKey(db, replacement)).toBeNull();
  expect(await validateApiKey(db, publicKey)).toEqual({ userId: ownerId });
  await db.update(apiKeys).set({ keyHash: hashApiKey(replacement) });
  expect(await validateApiKey(db, publicKey)).toBeNull();
  expect(await validateApiKey(db, replacement)).toEqual({ userId: ownerId });
  await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(replacement)));
  expect(await validateApiKey(db, replacement)).toBeNull();
});

it("observes a changed key owner on the next call", async () => {
  const [other] = await db
    .insert(users)
    .values({
      username: "other-owner",
      passwordHash: "test-only-hash",
    })
    .returning({ id: users.id });
  expect(await validateApiKey(db, publicKey)).toEqual({ userId: ownerId });
  await db.update(apiKeys).set({ userId: other.id });
  expect(await validateApiKey(db, publicKey)).toEqual({ userId: other.id });
});

it("propagates database failure instead of accepting a previously valid key", async () => {
  const unavailable = createDatabase(url.href);
  try {
    expect(await validateApiKey(unavailable.db, publicKey)).toEqual({
      userId: ownerId,
    });
  } finally {
    await unavailable.close();
  }
  await expect(validateApiKey(unavailable.db, publicKey)).rejects.toThrow();
});
