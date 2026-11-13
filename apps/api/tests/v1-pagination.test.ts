import { once } from "node:events";
import type { Server } from "node:http";
import { and, eq, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { runIngestTick } from "../src/ingest/tick.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_pagination_test";
const connection = createDatabase(url.href);
const writer = createDatabase(url.href);
const key = "public-v1-pagination-test-key";
const brandId = 92001;
let server: Server;
let origin: string;

function ad(id: string, impressionRank: number | null = null) {
  return {
    id,
    brandId,
    headline: "Serum",
    bodyText: "Full body",
    niche: "skincare" as const,
    format: "video" as const,
    status: "active" as const,
    startDate: "2026-01-01",
    endDate: null,
    impressionRank,
    countries: ["US"],
    discoveredAt: new Date("2026-01-01T00:00:00Z"),
  };
}

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v1_pagination_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  const [demo] = await connection.db.select().from(users).where(eq(users.username, "demo"));
  await connection.db.insert(apiKeys).values({ userId: demo.id, keyHash: hashApiKey(key) });
  await connection.db.insert(brands).values({ id: brandId, name: "Pagination Brand" });
  await listen(connection.db);
});

async function listen(db: typeof connection.db) {
  server = createApp({ db, jwtSecret: "public-v1-pagination-jwt-secret-32-bytes" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
}

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
  await writer.close();
});
beforeEach(async () => {
  await connection.db.delete(ads);
  await connection.db.insert(ads).values([ad("A", 1), ad("Z", 4), ad("a"), ad("z")]);
});

function request(query: string, authorization: string | null = `Bearer ${key}`) {
  return fetch(`${origin}/api/v1/ads?${query}`, {
    headers: authorization === null ? {} : { Authorization: authorization },
  });
}
async function page(query: string) {
  const response = await request(query);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  for (const row of body.data) {
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "brand_id",
        "brand_name",
        "headline",
        "niche",
        "format",
        "status",
        "start_date",
        "days_active",
        "impression_rank",
      ].sort(),
    );
  }
  expect(Object.keys(body).sort()).toEqual(
    ["data", "applied_filters", "sort", "limit", "next_cursor", "cursor_expires_at"].sort(),
  );
  return body;
}
function continuation(cursor: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ cursor, ...extra }).toString();
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String),
      next_action: expect.any(String),
      retryable: status === 500,
      details: expect.any(Array),
    },
  });
  return body;
}

// Two real inserts per tick: current/known rank and backdated/null rank.
// Random draws select exact old ads, never relying on UUID order or process waits.
async function ingest(deactivate: string[], beforeCommit?: () => Promise<void>) {
  const time = new Date("2026-01-01T00:00:00Z");
  const existingIds = new Set((await writer.db.select({ id: ads.id }).from(ads)).map((row) => row.id));
  const candidates = await writer.db
    .select({ id: ads.id })
    .from(ads)
    .where(and(eq(ads.status, "active"), lte(ads.startDate, "2026-01-01")))
    .orderBy(ads.id);
  const availableBrands = await writer.db.select({ id: brands.id }).from(brands).orderBy(brands.id);
  const brandDraw = (availableBrands.findIndex((brand) => brand.id === brandId) + 0.5) / availableBrands.length;
  const draws = [0.25, deactivate.length === 2 ? 0.5 : 0];
  for (const id of deactivate) {
    const index = candidates.findIndex((candidate) => candidate.id === id);
    expect(index).toBeGreaterThanOrEqual(0);
    draws.push((index + 0.5) / candidates.length);
    candidates.splice(index, 1);
  }
  draws.push(brandDraw, 0, 0, 0.3, 0.4, brandDraw, 0, 0, 0.1, 0, 0);
  const transaction = writer.db.transaction.bind(writer.db);
  const barrier = beforeCommit
    ? vi.spyOn(writer.db, "transaction").mockImplementationOnce((read, config) =>
        transaction(async (tx) => {
          const result = await read(tx);
          // All real tick writes are complete but uncommitted here.
          await beforeCommit();
          return result;
        }, config),
      )
    : undefined;
  try {
    await runIngestTick(writer.db, {
      clock: () => time,
      random: () => {
        const draw = draws.shift();
        if (draw === undefined) throw new Error("Unexpected ingest random draw");
        return draw;
      },
    });
    expect(draws).toEqual([]);
    const inserted = (await writer.db.select().from(ads).orderBy(ads.id)).filter((row) => !existingIds.has(row.id));
    // A boundary callback may also insert the pre-B control row on another connection.
    const generated = inserted.filter((row) => row.id.startsWith("ingest-ad-"));
    expect(generated).toHaveLength(2);
    return generated;
  } finally {
    barrier?.mockRestore();
  }
}

it.each(["newest", "impressions"].flatMap((sort) => ["", "active", "inactive"].map((status) => ({ sort, status }))))(
  "fully walks $sort/$status during controlled real ingest commits",
  async ({ sort, status }) => {
    await connection.db
      .insert(ads)
      .values([
        { ...ad("B", 2), status: "inactive", endDate: "2026-01-01" },
        ad("Y", 3),
        { ...ad("b"), status: "inactive", endDate: "2026-01-01" },
        ad("c"),
        ad("y"),
      ]);
    const query = `brand_id=${brandId}&sort=${sort}${status ? `&status=${status}` : ""}`;
    let initial: string[] = [];
    let first: Awaited<ReturnType<typeof page>> | undefined;
    const inFlight = await ingest(["Z"], async () => {
      // Advance xmax beyond the open tick: a simple max-xid fence would fail.
      await connection.db.insert(ads).values(ad("boundary", 8));
      initial = (await page(query)).data.map((row: { id: string }) => row.id);
      first = await page(`${query}&limit=1`);
      expect(first.data.map((row: { id: string }) => row.id)).toEqual([initial[0]]);
    });
    if (!first) throw new Error("First-page synchronization did not execute");
    const later = await ingest(["c"]);
    let targets = [inFlight[0].id, later[0].id];
    const seen: string[] = first.data.map((row: { id: string }) => row.id);
    let cursor = first.next_cursor;
    let index = 0;
    while (cursor) {
      // First target both an in-flight-at-B insert and a later insert, then each tick's
      // generated pair. UUID ordering cannot accidentally omit either provenance case.
      const generated = await ingest(targets);
      targets = generated.map((row) => row.id);
      const next = await page(continuation(cursor, { limit: String(1 + (index++ % 2)), brand_id: `0${brandId}` }));
      expect(next.applied_filters).toEqual(first.applied_filters);
      expect(next.cursor_expires_at).toBe(first.cursor_expires_at);
      expect(next.sort).toBe(sort);
      expect(next.data.length).toBeGreaterThan(0);
      expect(next.data.some((row: { id: string }) => row.id.startsWith("ingest-ad-"))).toBe(false);
      seen.push(...next.data.map((row: { id: string }) => row.id));
      expect(new Set(seen).size).toBe(seen.length);
      expect(index).toBeLessThan(12);
      cursor = next.next_cursor;
    }
    const continuouslyEligible = initial.filter((id) => status !== "active" || !["Z", "c"].includes(id));
    // Newly inactive rows may appear ahead, but are not part of the completeness promise.
    const guaranteed = status === "inactive" ? seen.filter((id) => !["Z", "c"].includes(id)) : seen;
    expect(guaranteed).toEqual(continuouslyEligible);
    expect(seen.some((id) => id.startsWith("ingest-ad-"))).toBe(false);
    const fresh = await page(query);
    expect(fresh.data.some((row: { id: string }) => row.id.startsWith("ingest-ad-"))).toBe(true);
    const stored = await writer.db.select().from(ads);
    const postBoundary = stored.filter((row) => row.id.startsWith("ingest-ad-"));
    expect(postBoundary.some((row) => row.startDate === "2025-12-31")).toBe(true);
    expect(postBoundary.some((row) => row.startDate === "2026-01-01")).toBe(true);
    expect(postBoundary.every((row) => row.discoveredAt.toISOString() === "2026-01-01T00:00:00.000Z")).toBe(true);
    for (const id of [inFlight[0].id, later[0].id]) {
      expect(postBoundary.find((row) => row.id === id)?.status).toBe("inactive");
    }
  },
);

it.each([false, true])("walks adversarial brand-local ranks and bytewise null IDs (all-null=%s)", async (allNull) => {
  await connection.db.delete(ads);
  const nullIds = ["!", "0", "A", "Z", "a", "z", "é", "Ω", "😀"];
  const known = allNull ? [] : [ad("rank-z", 1), ad("rank-a", 4), ad("rank-0", 2147483647)];
  await connection.db.insert(ads).values([...nullIds.map((id) => ad(id)).reverse(), ...[...known].reverse()]);
  // The same known ranks are legal in another brand, but never comparable.
  await connection.db
    .insert(brands)
    .values({ id: brandId + 1, name: "Other Rank Brand" })
    .onConflictDoNothing();
  await connection.db.insert(ads).values([
    { ...ad("other-first", 1), brandId: brandId + 1 },
    { ...ad("other-gap", 4), brandId: brandId + 1 },
    { ...ad("other-null"), brandId: brandId + 1 },
  ]);
  const first = await page(`sort=impressions&brand_id=0${brandId}&q=%20Serum%20&niche=skincare&niche=skincare&limit=1`);
  expect(first.applied_filters).toEqual({
    q: "Serum",
    niche: ["skincare"],
    format: null,
    status: null,
    started_after: null,
    brand_id: brandId,
  });
  expect(first.data[0]).toMatchObject({ id: allNull ? "!" : "rank-z", impression_rank: allNull ? null : 1 });
  const seen = first.data.map((row: { id: string }) => row.id);
  const ranks = first.data.map((row: { impression_rank: number | null }) => row.impression_rank);
  const expected = [...known.map((row) => row.id), ...nullIds];
  let cursor = first.next_cursor;
  let index = 0;
  while (cursor) {
    // End a page exactly at the last known rank, then traverse several null-only pages.
    const limit = index++ === 0 ? "2" : "1";
    const next = await page(continuation(cursor, { limit, brand_id: `${brandId}` }));
    expect(next.sort).toBe("impressions");
    expect(next.limit).toBe(Number(limit));
    expect(next.applied_filters).toEqual(first.applied_filters);
    expect(next.cursor_expires_at).toBe(first.cursor_expires_at);
    expect(next.data.length).toBeGreaterThan(0);
    expect(next.data.every((row: { brand_id: number }) => row.brand_id === brandId)).toBe(true);
    seen.push(...next.data.map((row: { id: string }) => row.id));
    ranks.push(...next.data.map((row: { impression_rank: number | null }) => row.impression_rank));
    expect(seen.length).toBeLessThanOrEqual(expected.length);
    expect(new Set(seen).size).toBe(seen.length);
    cursor = next.next_cursor;
  }
  expect(seen).toEqual(expected);
  expect(ranks).toEqual([...known.map((row) => row.impressionRank), ...nullIds.map(() => null)]);
  const other = await page(`sort=impressions&brand_id=${brandId + 1}`);
  expect(other.data.map((row: { id: string }) => row.id)).toEqual(["other-first", "other-gap", "other-null"]);
  expect(await page("sort=impressions&brand_id=2147483647")).toMatchObject({
    data: [],
    next_cursor: null,
    sort: "impressions",
    applied_filters: { brand_id: 2147483647 },
  });
});

it.each(["newest", "impressions"])(
  "inherits normalized filters and permits partial equivalent repeats and size changes: %s",
  async (sort) => {
    const first = await page(
      `q=%20Serum%20&niche=skincare&niche=skincare&format=video&status=active&started_after=2025-12-31&brand_id=${brandId}&sort=${sort}&limit=1`,
    );
    const second = await page(
      continuation(first.next_cursor, { brand_id: `0${brandId}`, niche: "skincare", limit: "2" }),
    );
    expect(second.applied_filters).toEqual(first.applied_filters);
    expect(second.sort).toBe(sort);
    expect(second.data.map((row: { id: string }) => row.id)).toEqual(["Z", "a"]);
    const final = await page(continuation(second.next_cursor));
    expect(final.limit).toBe(20);
    expect(final.data.map((row: { id: string }) => row.id)).toEqual(["z"]);
    expect(final.next_cursor).toBeNull();
    expect(final.cursor_expires_at).toBe(first.cursor_expires_at);
    for (const changed of [
      { q: "other" },
      { niche: "haircare" },
      { format: "image" },
      { status: "inactive" },
      { started_after: "2026-01-01" },
      { brand_id: "1" },
      { sort: sort === "newest" ? "impressions" : "newest" },
    ]) {
      await expectError(await request(continuation(first.next_cursor, changed)), 422, "CURSOR_QUERY_MISMATCH");
    }
    await expectError(await request(continuation(first.next_cursor, { format: "VIDEO" })), 422, "VALIDATION_ERROR");
    await expectError(await request(`${continuation(first.next_cursor)}&limit=1&limit=2`), 422, "VALIDATION_ERROR");
    await expectError(await request(`${continuation(first.next_cursor)}&niche[]=skincare`), 422, "VALIDATION_ERROR");
  },
);

it.each(["newest", "impressions"])(
  "excludes backdated inserts committed after B, including an in-flight transaction: %s",
  async (sort) => {
    const query = `brand_id=${brandId}&sort=${sort}&limit=1`;
    // The transaction is open before the HTTP request and commits only after page one.
    // Its insert has the same discovery timestamp and a backdated start date.
    const first = await writer.db.transaction(async (tx) => {
      await tx.insert(ads).values([
        { ...ad("in-flight", 7), startDate: "2025-12-31" },
        { ...ad("in-flight-null"), startDate: "2025-12-31" },
      ]);
      // Assign a later committed xid before B; a simple max-xid fence would fail.
      await connection.db.insert(ads).values(ad("b", 6));
      return page(query);
    });
    await writer.db.insert(ads).values([
      { ...ad("later", 9), startDate: "2025-12-30" },
      { ...ad("later-null"), startDate: "2025-12-30" },
    ]);
    const remaining = await page(continuation(first.next_cursor));
    expect([first.data[0].id, ...remaining.data.map((row: { id: string }) => row.id)]).toEqual(
      sort === "newest" ? ["A", "Z", "a", "b", "z"] : ["A", "Z", "b", "a", "z"],
    );
    expect(remaining.next_cursor).toBeNull();
    // They really committed and would match a new search.
    const fresh = await page(`brand_id=${brandId}&sort=${sort}`);
    expect(fresh.data.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining(["in-flight", "in-flight-null", "later", "later-null"]),
    );
  },
);

it.each(["newest", "impressions"])(
  "applies live deactivation without losing unfiltered insertion membership: %s",
  async (sort) => {
    const query = `brand_id=${brandId}&sort=${sort}&limit=1`;
    const active = await page(`${query}&status=active`);
    const all = await page(query);
    const before = await page(continuation(all.next_cursor));
    expect(before.data.map((row: { status: string }) => row.status)).toEqual(["active", "active", "active"]);
    for (const id of ["Z", "a"]) {
      await writer.db.update(ads).set({ status: "inactive", endDate: "2026-01-03" }).where(eq(ads.id, id));
    }
    const activeRest = await page(continuation(active.next_cursor));
    expect(activeRest.data.map((row: { id: string }) => row.id)).toEqual(["z"]);
    const allRest = await page(continuation(all.next_cursor));
    expect(allRest.data.map((row: { id: string }) => row.id)).toEqual(["Z", "a", "z"]);
    expect(allRest.data[0]).toMatchObject({ status: "inactive", days_active: 2 });
    expect(allRest.cursor_expires_at).toBe(before.cursor_expires_at);
    expect(allRest.data.map((row: { id: string }) => row.id)).toEqual(before.data.map((row: { id: string }) => row.id));
    // If every unread ad becomes ineligible, exhaustion is an empty successful page.
    await writer.db.update(ads).set({ status: "inactive", endDate: "2026-01-03" });
    expect(await page(continuation(active.next_cursor))).toMatchObject({
      data: [],
      next_cursor: null,
      cursor_expires_at: active.cursor_expires_at,
      applied_filters: active.applied_filters,
    });
  },
);

it.each(["newest", "impressions"])("observes newly inactive rows only ahead of the %s position", async (sort) => {
  for (const id of ["Z", "z"]) {
    await writer.db.update(ads).set({ status: "inactive", endDate: "2026-01-03" }).where(eq(ads.id, id));
  }
  const first = await page(`sort=${sort}&brand_id=${brandId}&status=inactive&limit=1`);
  expect(first.data.map((row: { id: string }) => row.id)).toEqual(["Z"]);
  expect(first.next_cursor).toEqual(expect.any(String));
  // A is behind the position; a becomes eligible ahead of it.
  for (const id of ["A", "a"]) {
    await writer.db.update(ads).set({ status: "inactive", endDate: "2026-01-03" }).where(eq(ads.id, id));
  }
  const second = await page(continuation(first.next_cursor, { limit: "1" }));
  expect(second.data).toEqual([expect.objectContaining({ id: "a", status: "inactive", days_active: 2 })]);
  // A behind the position must not return, even after reaching the null ranks.
  const final = await page(continuation(second.next_cursor, { limit: "1" }));
  expect(final.data.map((row: { id: string }) => row.id)).toEqual(["z"]);
  expect(final.next_cursor).toBeNull();
  expect(final.applied_filters).toEqual(first.applied_filters);
  expect(final.cursor_expires_at).toBe(first.cursor_expires_at);
  const fresh = await page(`sort=${sort}&brand_id=${brandId}&status=inactive`);
  expect(fresh.data.map((row: { id: string }) => row.id)).toEqual(["A", "Z", "a", "z"]);
});

it.each(["newest", "impressions"])("replays tokens with fixed expiry at the exact boundary: %s", async (sort) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-02T23:59:59.999Z"));
  try {
    const first = await page(`sort=${sort}&brand_id=${brandId}&limit=1`);
    expect(first.cursor_expires_at).toBe("2026-01-03T00:29:59.999Z");
    expect(first.data[0].days_active).toBe(1);
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
    const second = await page(continuation(first.next_cursor, { limit: "1" }));
    expect(second.data[0].days_active).toBe(2);
    expect(second.cursor_expires_at).toBe(first.cursor_expires_at);
    const replay = await page(continuation(first.next_cursor, { limit: "1" }));
    expect(replay.data).toEqual(second.data);
    expect(replay.applied_filters).toEqual(second.applied_filters);
    expect(replay.cursor_expires_at).toBe(second.cursor_expires_at);
    vi.setSystemTime(new Date("2026-01-03T00:29:59.998Z"));
    expect((await page(continuation(second.next_cursor))).cursor_expires_at).toBe(first.cursor_expires_at);
    vi.setSystemTime(new Date(first.cursor_expires_at));
    const error = await expectError(await request(continuation(second.next_cursor)), 422, "CURSOR_EXPIRED");
    expect(error.error.next_action).toContain("fresh search");
  } finally {
    vi.useRealTimers();
  }
});

it.each(["newest", "impressions"])(
  "agrees with v0/detail at equal state and time across UTC midnight: %s",
  async (sort) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-02T23:59:59.999Z"));
      const first = await page(`sort=${sort}&brand_id=${brandId}&limit=1`);
      const before = await page(continuation(first.next_cursor));
      expect(before.data.map((row: { days_active: number }) => row.days_active)).toEqual([1, 1, 1]);
      await writer.db.update(ads).set({ status: "inactive", endDate: "2026-01-02" }).where(eq(ads.id, "a"));
      for (const time of ["2026-01-02T23:59:59.999Z", "2026-01-03T00:00:00.000Z"]) {
        vi.setSystemTime(new Date(time));
        const current = await page(continuation(first.next_cursor));
        expect(current.cursor_expires_at).toBe(first.cursor_expires_at);
        const legacyResponse = await fetch(`${origin}/api/v0/ads?api_key=${key}&q=Serum`);
        expect(legacyResponse.status).toBe(200);
        const legacy = await legacyResponse.json();
        for (const row of current.data) {
          const detailResponse = await fetch(`${origin}/api/v1/ads/${row.id}`, {
            headers: { Authorization: `Bearer ${key}` },
          });
          expect(detailResponse.status).toBe(200);
          const detail = await detailResponse.json();
          const expectedDays = row.id === "a" || time.startsWith("2026-01-02") ? 1 : 2;
          expect(row.days_active).toBe(expectedDays);
          expect(detail.data).toMatchObject(row);
          expect(detail.data.end_date).toBe(row.id === "a" ? "2026-01-02" : null);
          expect(legacy.data.find((ad: { id: string }) => ad.id === row.id)).toMatchObject({
            id: row.id,
            status: row.status,
            days_active: expectedDays,
          });
        }
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["newest", "impressions"])("authenticates every continuation before validation: %s", async (sort) => {
  const first = await page(`sort=${sort}&brand_id=${brandId}&limit=1`);
  await expectError(await request("cursor=invalid&limit=no", null), 401, "UNAUTHENTICATED");
  await expectError(await request(continuation(first.next_cursor), "Bearer invalid"), 401, "UNAUTHENTICATED");
  await connection.db
    .update(apiKeys)
    .set({ keyHash: hashApiKey(`${key}-changed`) })
    .where(eq(apiKeys.keyHash, hashApiKey(key)));
  try {
    await expectError(await request(continuation(first.next_cursor)), 401, "UNAUTHENTICATED");
    expect((await request(continuation(first.next_cursor), `Bearer ${key}-changed`)).status).toBe(200);
  } finally {
    await connection.db
      .update(apiKeys)
      .set({ keyHash: hashApiKey(key) })
      .where(eq(apiKeys.keyHash, hashApiKey(`${key}-changed`)));
  }
});

it.each(["newest", "impressions"])(
  "replays after restarting the HTTP app with an independent pool: %s",
  async (sort) => {
    const first = await page(`sort=${sort}&brand_id=${brandId}&limit=1`);
    const expected = await page(continuation(first.next_cursor, { limit: "1" }));
    expect(connection.db.$client.idleCount).toBe(connection.db.$client.totalCount);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    const restarted = createDatabase(url.href);
    try {
      await listen(restarted.db);
      const replay = await page(continuation(first.next_cursor, { limit: "1", sort }));
      expect(replay).toMatchObject({
        data: expected.data,
        applied_filters: first.applied_filters,
        cursor_expires_at: first.cursor_expires_at,
        sort,
      });
      const final = await page(continuation(replay.next_cursor));
      expect(final.data.map((row: { id: string }) => row.id)).toEqual(["a", "z"]);
      expect(final.next_cursor).toBeNull();
      expect(final.cursor_expires_at).toBe(first.cursor_expires_at);
      expect(restarted.db.$client.idleCount).toBe(restarted.db.$client.totalCount);
      const sessions = await writer.db.execute(sql`SELECT state, xact_start FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`);
      expect(sessions.rows.length).toBeGreaterThan(0);
      for (const session of sessions.rows) expect(session).toMatchObject({ state: "idle", xact_start: null });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await restarted.close();
      await listen(connection.db);
    }
  },
);

it.each(["newest", "impressions"])("sanitizes no-store cursor and database errors: %s", async (sort) => {
  const first = await page(`sort=${sort}&brand_id=${brandId}&limit=1`);
  const token: string = first.next_cursor;
  for (const cursor of ["", "not-a-token", token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21)]) {
    await expectError(await request(continuation(cursor)), 422, "INVALID_CURSOR");
  }
  const spies = (["log", "info", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  const failure = vi
    .spyOn(connection.db, "transaction")
    .mockRejectedValueOnce(new Error(`SELECT inserted_xid ${key} ${token}`));
  try {
    const error = await expectError(await request("limit=1"), 500, "INTERNAL_ERROR");
    expect(JSON.stringify(error)).not.toMatch(/SELECT|inserted_xid|snapshot/);
    expect(JSON.stringify(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(token);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    failure.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
  expect((await request("limit=1")).status).toBe(200);
});
