import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it } from "vitest";

import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_search_test";
const connection = createDatabase(url.href);
const key = "public-v1-search-test-key";
let server: Server;
let origin: string;
const brandId = 91001;
const otherBrand = 91002;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v1_search_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  await connection.db.delete(ads);
  const [demo] = await connection.db.select().from(users).where(eq(users.username, "demo"));
  await connection.db.insert(apiKeys).values({ userId: demo.id, keyHash: hashApiKey(key) });
  await connection.db.insert(brands).values([
    { id: brandId, name: "Search Brand" },
    { id: otherBrand, name: "Other Brand" },
  ]);
  const base = {
    brandId,
    headline: "Serum",
    bodyText: "Ordinary body",
    niche: "skincare" as const,
    format: "video" as const,
    status: "active" as const,
    startDate: "2026-01-02",
    endDate: null,
    impressionRank: null,
    countries: ["US"],
    discoveredAt: new Date("2026-01-01Z"),
  };
  await connection.db.insert(ads).values([
    { ...base, id: "A", headline: "SERUM 50%_\\ off", impressionRank: 3 },
    { ...base, id: "Z", headline: "Other", bodyText: "Try sErUm", impressionRank: 1 },
    { ...base, id: "a", niche: "haircare", format: "image", startDate: "2026-01-01" },
    { ...base, id: "z", status: "inactive", endDate: "2026-01-04", startDate: "2026-01-01" },
    { ...base, id: "é", brandId: otherBrand, headline: "Unrelated", niche: "fitness" },
    { ...base, id: "literal-decoy", headline: "50XX off", bodyText: "Unrelated", startDate: "2025-12-31" },
  ]);
  server = createApp({ db: connection.db, jwtSecret: "public-v1-search-jwt-secret-32-bytes" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

async function search(query = "") {
  const response = await fetch(`${origin}/api/v1/ads?${query}`, { headers: { Authorization: `Bearer ${key}` } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

it.each([
  ["q=serum", ["A", "Z", "a", "z"]],
  ["q=50%25_%5C", ["A"]],
  ["q=%25", ["A"]],
  ["q=_", ["A"]],
  ["q=%5C", ["A"]],
  ["niche=haircare", ["a"]],
  ["niche=haircare&niche=fitness", ["é", "a"]],
  ["format=image", ["a"]],
  ["status=inactive", ["z"]],
  ["status=active", ["A", "Z", "é", "a", "literal-decoy"]],
  ["started_after=2026-01-01", ["A", "Z", "é"]],
  [`brand_id=${otherBrand}`, ["é"]],
  ["brand_id=2147483647", []],
  [`q=serum&niche=skincare&format=video&status=active&started_after=2026-01-01&brand_id=${brandId}`, ["A", "Z"]],
])("applies filter %s against positive and negative fixtures", async (query, ids) => {
  const body = await search(query);
  expect(body.data.map((ad: { id: string }) => ad.id)).toEqual(ids);
  expect(body.next_cursor).toBeNull();
});

it("returns the exact normalized envelope and summary allowlist, including empty results", async () => {
  const query = `q=%20SERUM%20&niche=skincare&niche=skincare&format=video&status=active&started_after=2026-01-01&brand_id=0${brandId}`;
  const body = await search(query);
  expect(body).toEqual({
    data: ["A", "Z"].map((id) => ({
      id,
      brand_id: brandId,
      brand_name: "Search Brand",
      headline: id === "A" ? "SERUM 50%_\\ off" : "Other",
      niche: "skincare",
      format: "video",
      status: "active",
      start_date: "2026-01-02",
      days_active: expect.any(Number),
      impression_rank: id === "A" ? 3 : 1,
    })),
    applied_filters: {
      q: "SERUM",
      niche: ["skincare"],
      format: "video",
      status: "active",
      started_after: "2026-01-01",
      brand_id: brandId,
    },
    sort: "newest",
    limit: 20,
    next_cursor: null,
    cursor_expires_at: expect.any(String),
  });
  expect(await search("q=absent")).toEqual({
    data: [],
    applied_filters: { q: "absent", niche: [], format: null, status: null, started_after: null, brand_id: null },
    sort: "newest",
    limit: 20,
    next_cursor: null,
    cursor_expires_at: expect.any(String),
  });
});

it.each([
  ["", ["A", "Z", "é", "a", "z", "literal-decoy"]],
  [`sort=impressions&brand_id=${brandId}`, ["Z", "A", "a", "literal-decoy", "z"]],
])("continues both bytewise orderings from the last returned row: %s", async (query, ids) => {
  const first = await search(`${query}&limit=1`);
  const seen = first.data.map((ad: { id: string }) => ad.id);
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await search(new URLSearchParams({ cursor, limit: "2" }).toString());
    expect(page.cursor_expires_at).toBe(first.cursor_expires_at);
    expect(page.applied_filters).toEqual(first.applied_filters);
    expect(page.sort).toBe(first.sort);
    expect(page.limit).toBe(2);
    seen.push(...page.data.map((ad: { id: string }) => ad.id));
    cursor = page.next_cursor;
    expect(seen.length).toBeLessThanOrEqual(ids.length);
  }
  expect(seen).toEqual(ids);
});

it.each(["%00", "ser%00um", "%00serum", "serum%00"])(
  "rejects q=%s as invalid text on initial and continuation requests",
  async (q) => {
    const first = await search("limit=1");
    for (const suffix of ["", `&${new URLSearchParams({ cursor: first.next_cursor })}`]) {
      const response = await fetch(`${origin}/api/v1/ads?q=${q}${suffix}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(response.status).toBe(422);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: expect.any(String),
          next_action: expect.any(String),
          retryable: false,
          details: [{ parameter: "q", reason: "invalid_text", allowed_values: [], suggestion: null }],
        },
      });
    }
  },
);

it("rejects impressions without a brand with actionable no-store errors", async () => {
  const response = await fetch(`${origin}/api/v1/ads?sort=impressions`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(response.status).toBe(422);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(body.error.message).toContain("brand_id");
  expect(body.error.next_action).toContain("newest");
  expect(body.error.next_action).toContain("brand_id");
  expect(body.error.retryable).toBe(false);
  expect(body.error.details).toEqual([
    { parameter: "brand_id", reason: "required_for_impressions", allowed_values: [], suggestion: null },
  ]);
  // Both recommended corrections are usable, without silently comparing brands.
  const local = await search(`sort=impressions&brand_id=${brandId}`);
  expect(local.data.map((ad: { id: string }) => ad.id)).toEqual(["Z", "A", "a", "literal-decoy", "z"]);
  const crossBrand = await search("sort=newest");
  expect(crossBrand.data.map((ad: { id: string }) => ad.id)).toEqual(["A", "Z", "é", "a", "z", "literal-decoy"]);
});
