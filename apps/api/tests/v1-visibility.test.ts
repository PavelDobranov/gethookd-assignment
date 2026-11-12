import { and, count, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { readFirstPage, visibleAtBoundary } from "../src/ads/visibility.js";
import { createDatabase } from "../src/db/client.js";
import { generateFixtures } from "../src/db/fixtures.js";
import { ads, brands } from "../src/db/schema.js";
import { seedWorld } from "../src/db/seed-world.js";

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

it.each(["2025-01-01T00:00:00.000Z", discoveredAt.toISOString()])(
  "excludes an insert in flight at B, even from a savepoint with discovery time %s",
  async (time) => {
    await db.insert(ads).values(ad("before"));
    const boundary = await writer.db.transaction(async (tx) => {
      const top = await tx.execute<{ xid: string }>(sql`SELECT pg_current_xact_id()::text AS xid`);
      const xid = top.rows[0].xid;
      expect(xid).toMatch(/^\d+$/);
      await tx.transaction(async (savepoint) => {
        const [inserted] = await savepoint
          .insert(ads)
          .values({ ...ad("in-flight"), discoveredAt: new Date(time) })
          .returning({ insertedXid: ads.insertedXid, tupleXid: sql<string>`xmin::text` });
        expect(inserted.insertedXid).toBe(xid);
        // A real subtransaction wrote the tuple, but provenance is top-level.
        expect(inserted.tupleXid).not.toBe(xid);
      });
      // Advance xmax beyond the open writer; a max-ID fence alone would admit it.
      await db.insert(ads).values(ad("committed-before-B"));
      const first = await readFirstPage(db, (reader) => reader.select({ id: ads.id }).from(ads).orderBy(ads.id));
      expect(first.data).toEqual([{ id: "before" }, { id: "committed-before-B" }]);
      expect(first.snapshot.split(":")[2].split(",")).toContain(xid);
      return first.snapshot;
    }); // The in-flight insert commits only after B and its first page finish.
    await db.insert(ads).values({ ...ad("after"), discoveredAt: new Date(time) });
    expect(await db.select({ id: ads.id }).from(ads).where(visibleAtBoundary(boundary)).orderBy(ads.id)).toEqual([
      { id: "before" },
      { id: "committed-before-B" },
    ]);
    expect(await db.select({ total: count() }).from(ads)).toEqual([{ total: 4 }]);
  },
);

it("keeps original membership through deactivation while reading live status and end dates", async () => {
  await db.insert(ads).values([ad("before-updated"), ad("before-still-active")]);
  const first = await readFirstPage(db, (tx) => tx.select().from(ads).orderBy(ads.id));
  await db.insert(ads).values(ad("after-updated"));
  const markers = await db.select({ id: ads.id, insertedXid: ads.insertedXid }).from(ads).orderBy(ads.id);
  await writer.db
    .update(ads)
    .set({ status: "inactive", endDate: "2026-01-02" })
    .where(inArray(ads.id, ["before-updated", "after-updated"]));
  expect(await db.select({ id: ads.id, insertedXid: ads.insertedXid }).from(ads).orderBy(ads.id)).toEqual(markers);
  const live = await db
    .select({ id: ads.id, status: ads.status, endDate: ads.endDate })
    .from(ads)
    .where(visibleAtBoundary(first.snapshot))
    .orderBy(ads.id);
  expect(live).toEqual([
    { id: "before-still-active", status: "active", endDate: null },
    { id: "before-updated", status: "inactive", endDate: "2026-01-02" },
  ]);
  for (const status of ["active", "inactive"] as const) {
    expect(
      await db
        .select({ id: ads.id })
        .from(ads)
        .where(and(visibleAtBoundary(first.snapshot), eq(ads.status, status))),
    ).toEqual([{ id: status === "active" ? "before-still-active" : "before-updated" }]);
  }
  expect(first.data.find((row) => row.id === "before-updated")).toMatchObject({ status: "active", endDate: null });
  expect((await db.select().from(ads).where(eq(ads.id, "after-updated")))[0]).toMatchObject({
    status: "inactive",
    endDate: "2026-01-02",
  });
});

it("round-trips xid8 and snapshot text above JavaScript's safe integer range without numeric conversion", async () => {
  const xid = "9007199254740993";
  const snapshot = `${xid}:9007199254740995:${xid}`;
  const result = await db.execute<{ xid: string; snapshot: string; visible: boolean }>(sql`SELECT
    ${xid}::xid8 AS xid, ${snapshot}::pg_snapshot::text AS snapshot,
    pg_visible_in_snapshot(${xid}::xid8, ${snapshot}::pg_snapshot) AS visible`);
  expect(result.rows).toEqual([{ xid, snapshot, visible: false }]);
});

it("reads insertion membership over the 20,000-ad seed within unchanged query deadlines", async () => {
  await db.transaction((tx) => seedWorld(tx, generateFixtures()));
  const start = performance.now();
  const first = await readFirstPage(db, (tx) => tx.select({ id: ads.id }).from(ads).orderBy(ads.id).limit(21));
  const firstMs = performance.now() - start;
  const continuationStart = performance.now();
  const total = await db.select({ total: count() }).from(ads).where(visibleAtBoundary(first.snapshot));
  const membershipMs = performance.now() - continuationStart;
  expect(first.data).toHaveLength(21);
  expect(total).toEqual([{ total: 20_000 }]);
  expect(firstMs).toBeLessThan(2000);
  expect(membershipMs).toBeLessThan(2000);
  const version = await db.execute<{ version: string }>(sql`SELECT current_setting('server_version') AS version`);
  expect(version.rows[0].version).toMatch(/^17\./);
  console.info(
    `[visibility] PostgreSQL ${version.rows[0].version}; 20000 ads; first=${firstMs.toFixed(1)}ms; membership=${membershipMs.toFixed(1)}ms`,
  );
}, 20000);
