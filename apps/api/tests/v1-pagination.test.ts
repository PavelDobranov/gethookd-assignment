import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";

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
  server = createApp({ db: connection.db, jwtSecret: "public-v1-pagination-jwt-secret-32-bytes" }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

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
      await tx.insert(ads).values({ ...ad("in-flight", 7), startDate: "2025-12-31" });
      // Assign a later committed xid before B; a simple max-xid fence would fail.
      await connection.db.insert(ads).values(ad("b", 6));
      return page(query);
    });
    await writer.db.insert(ads).values({ ...ad("later", 9), startDate: "2025-12-30" });
    const remaining = await page(continuation(first.next_cursor));
    expect([first.data[0].id, ...remaining.data.map((row: { id: string }) => row.id)]).toEqual(
      sort === "newest" ? ["A", "Z", "a", "b", "z"] : ["A", "Z", "b", "a", "z"],
    );
    expect(remaining.next_cursor).toBeNull();
    // They really committed and would match a new search.
    const fresh = await page(`brand_id=${brandId}&sort=${sort}`);
    expect(fresh.data.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining(["in-flight", "later"]));
  },
);

it.each(["newest", "impressions"])(
  "applies live deactivation without losing unfiltered insertion membership: %s",
  async (sort) => {
    const query = `brand_id=${brandId}&sort=${sort}&limit=1`;
    const active = await page(`${query}&status=active`);
    const all = await page(query);
    await writer.db.update(ads).set({ status: "inactive", endDate: "2026-01-03" }).where(eq(ads.id, "Z"));
    const activeRest = await page(continuation(active.next_cursor));
    expect(activeRest.data.map((row: { id: string }) => row.id)).toEqual(["a", "z"]);
    const allRest = await page(continuation(all.next_cursor));
    expect(allRest.data.map((row: { id: string }) => row.id)).toEqual(["Z", "a", "z"]);
    expect(allRest.data[0]).toMatchObject({ status: "inactive", days_active: 2 });
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

it("replays tokens, retains fixed expiry, and expires at the exact boundary", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-02T23:59:59.999Z"));
  try {
    const first = await page("limit=1");
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

it("authenticates continuations before validation and consults stored keys every time", async () => {
  const first = await page("limit=1");
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

it("returns sanitized no-store cursor and database errors without logs or internal markers", async () => {
  const first = await page("limit=1");
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
