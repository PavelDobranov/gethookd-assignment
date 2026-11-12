import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { readFirstPage, visibleAtBoundary } from "../src/ads/visibility.js";
import { createDatabase } from "../src/db/client.js";
import { ads, brands } from "../src/db/schema.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_visibility_test";
const { db, close } = createDatabase(url.href);
const writer = createDatabase(url.href);
const discoveredAt = new Date("2026-01-01T00:00:00.000Z");

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_visibility_test`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  await close();
  await writer.close();
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE ads, brands`);
  await db.insert(brands).values({ id: 1, name: "Visibility" });
});

function ad(id: string) {
  return {
    id,
    brandId: 1,
    headline: "Serum",
    bodyText: "Body",
    niche: "skincare" as const,
    format: "image" as const,
    status: "active" as const,
    startDate: "2025-01-01",
    countries: ["US"],
    discoveredAt,
  };
}

it("captures text and its page under one read-only repeatable-read snapshot, then releases the connection", async () => {
  await db.insert(ads).values(ad("before"));
  const first = await readFirstPage(db, async (tx) => {
    const settings = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only`);
    expect(settings.rows).toEqual([{ isolation: "repeatable read", read_only: "on" }]);
    // Explicitly commit between snapshot capture and the page SELECT.
    await writer.db.insert(ads).values(ad("after"));
    return tx.select({ id: ads.id, insertedXid: ads.insertedXid }).from(ads).orderBy(ads.id);
  });
  expect(first.snapshot).toMatch(/^\d+:\d+:(?:\d+(?:,\d+)*)?$/);
  expect(first.data).toEqual([{ id: "before", insertedXid: expect.any(String) }]);
  expect(await db.select({ id: ads.id }).from(ads).where(visibleAtBoundary(first.snapshot))).toEqual([
    { id: "before" },
  ]);
  expect(await db.select({ id: ads.id }).from(ads).orderBy(ads.id)).toEqual([{ id: "after" }, { id: "before" }]);
  expect(db.$client.idleCount).toBe(db.$client.totalCount);
  const settings = await db.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`);
  expect(settings.rows).toEqual([{ isolation: "read committed", read_only: "off" }]);
});

it("rejects writes and releases the transaction on failure", async () => {
  await db.insert(ads).values(ad("before"));
  await expect(
    readFirstPage(db, (tx) => tx.update(ads).set({ headline: "Not allowed" }).where(eq(ads.id, "before"))),
  ).rejects.toMatchObject({ cause: { code: "25006" } });
  expect((await db.select().from(ads))[0].headline).toBe("Serum");
  expect(db.$client.idleCount).toBe(db.$client.totalCount);
  await db.insert(ads).values(ad("after-failure"));
});
