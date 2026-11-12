import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import { niches } from "../src/ads/model.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v0_test";
const connection = createDatabase(url.href);
const key = "public-v0-test-key";
let server: Server;
let origin: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v0_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  await connection.db.delete(ads);
  await connection.db.delete(brands);
  await connection.db.insert(brands).values({ id: 1, name: "Contract Brand" });
  const [demo] = await connection.db
    .select()
    .from(users)
    .where(eq(users.username, "demo"));
  await connection.db
    .insert(apiKeys)
    .values({ userId: demo.id, keyHash: hashApiKey(key) });
  await connection.db.insert(ads).values({
    id: "contract-ad",
    brandId: 1,
    headline: "Serum glow",
    bodyText: "Daily care",
    niche: "skincare",
    format: "video",
    status: "inactive",
    startDate: "2026-01-01",
    endDate: "2026-01-04",
    impressionRank: null,
    countries: ["US"],
    discoveredAt: new Date("2026-01-05T00:00:00Z"),
  });
  const common = {
    brandId: 1,
    bodyText: "Quiet baseline",
    niche: "tech-accessories" as const,
    format: "image" as const,
    status: "active" as const,
    startDate: "2024-01-01",
    endDate: null,
    impressionRank: null,
    countries: ["GB"],
    discoveredAt: new Date("2026-01-05T00:00:00Z"),
  };
  await connection.db.insert(ads).values([
    {
      ...common,
      id: "body-ad",
      headline: "Quiet room",
      bodyText: "SERUM body",
      niche: "home-decor",
      startDate: "2025-12-02",
    },
    {
      ...common,
      id: "literal-ad",
      headline: "100%_\\proof",
      niche: "skincare",
      format: "carousel",
      startDate: "2025-12-01",
    },
    {
      ...common,
      id: "pet-ad",
      headline: "Collar serum",
      niche: "pet-supplies",
      format: "video",
      startDate: "2025-11-01",
    },
    {
      ...common,
      id: "tie-ad",
      headline: "Power serum",
      niche: "fitness",
      status: "inactive",
      startDate: "2025-11-01",
      endDate: "2025-11-03",
    },
    ...niches.map(({ slug }, index) => ({
      ...common,
      id: `catalog-${index}`,
      headline: "Catalog item",
      niche: slug,
    })),
    ...Array.from({ length: 120 }, (_, index) => ({
      ...common,
      id: `filler-${index}`,
      headline: `Filler ${index}`,
    })),
  ]);
  server = createApp({
    db: connection.db,
    jwtSecret: "public-v0-test-signing-secret-32-bytes",
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await connection.close();
});

it("serves only the legacy allowlisted fields using a stored key", async () => {
  const response = await fetch(
    `${origin}/api/v0/ads?api_key=${key}&q=Serum+glow`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: [
      {
        id: "contract-ad",
        brand: "Contract Brand",
        headline: "Serum glow",
        niche: "Skincare",
        format: "video",
        status: "inactive",
        start_date: "2026-01-01",
        days_active: 3,
      },
    ],
    page: 1,
    total: 1,
  });
});

async function getAds(query = "") {
  const response = await fetch(`${origin}/api/v0/ads?api_key=${key}&${query}`);
  expect(response.status).toBe(200);
  return response.json();
}

it.each([
  ["q=sErUm", ["contract-ad", "body-ad", "pet-ad", "tie-ad"]],
  ["q=SERUM&niche=SKINCARE", ["contract-ad"]],
  ["q=serum&format=video", ["contract-ad", "pet-ad"]],
  ["q=serum&status=active", ["body-ad", "pet-ad"]],
  ["q=serum&niche=Pet+Supplies&format=video&status=active", ["pet-ad"]],
  ["q=serum&niche=skincare&format=image", []],
  ["q=missing", []],
  ["q=%25", ["literal-ad"]],
  ["q=_", ["literal-ad"]],
  ["q=%5C", ["literal-ad"]],
  ["q=%25_%5C", ["literal-ad"]],
  ["q=%27+OR+1%3D1+--", []],
])(
  "applies parameterized literal search and combined filters: %s",
  async (query, ids) => {
    const body = await getAds(query);
    expect(body.total).toBe(ids.length);
    expect(body.data.map((ad: { id: string }) => ad.id).sort()).toEqual(
      [...ids].sort(),
    );
  },
);

it("returns default and clamped offset pages with full totals and date-only descending order", async () => {
  const first = await getAds();
  expect(first.page).toBe(1);
  expect(first.total).toBe(137);
  expect(first.data).toHaveLength(20);
  const dates = first.data.map((ad: { start_date: string }) => ad.start_date);
  expect(dates).toEqual([...dates].sort().reverse());
  expect(
    new Set(first.data.slice(3, 5).map((ad: { id: string }) => ad.id)),
  ).toEqual(new Set(["pet-ad", "tie-ad"]));
  const clamped = await getAds("per_page=101");
  expect(clamped.data).toHaveLength(100);
  const second = await getAds("page=2&per_page=9007199254740991");
  expect(second.page).toBe(2);
  expect(second.total).toBe(137);
  expect(second.data).toHaveLength(37);
  expect(await getAds("page=200")).toEqual({ data: [], page: 200, total: 137 });
  expect(await getAds("q=serum&page=2&per_page=2")).toMatchObject({
    page: 2,
    total: 4,
  });
  expect((await getAds("page=0002&per_page=003")).data).toHaveLength(3);
});

it.each(niches)(
  "accepts slug/display names without losing $name in the response",
  async ({ slug, name }) => {
    for (const niche of [slug, name, slug.toUpperCase(), name.toUpperCase()]) {
      const body = await getAds(
        new URLSearchParams({ q: "Catalog", niche }).toString(),
      );
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].niche).toBe(name);
    }
  },
);

it.each([
  "niche=",
  "niche=unknown",
  "niche=+skincare",
  "niche=Skincare+",
  "format=",
  "format=VIDEO",
  "format=Video",
  "format=video+",
  "format=unknown",
  "status=",
  "status=ACTIVE",
  "status=Active",
  "status=+active",
  "status=unknown",
])(
  "ignores invalid filter while retaining valid combined filters: %s",
  async (invalid) => {
    const valid = invalid.startsWith("niche")
      ? "format=video&status=inactive"
      : invalid.startsWith("format")
        ? "niche=skincare&status=inactive"
        : "niche=skincare&format=video";
    const body = await getAds(`q=serum&${valid}&${invalid}`);
    expect(body.total).toBe(1);
    expect(body.data.map((ad: { id: string }) => ad.id)).toEqual([
      "contract-ad",
    ]);
  },
);

it("ignores exact-name mismatches, repeated unknowns, sort and bracketed names", async () => {
  const body = await getAds(
    "q=serum&niche[x]=bad&niche[x]=worse&sort=asc&sort=desc&other=1&other=2&Q=missing&Q=absent&api_key[]=bad&page[]=bad&per_page[x]=bad",
  );
  expect(body.total).toBe(4);
  expect(body.data.map((ad: { id: string }) => ad.id).sort()).toEqual([
    "body-ad",
    "contract-ad",
    "pet-ad",
    "tie-ad",
  ]);
  expect((await getAds("q=serum&niche=skincare&niche[x]=fitness")).total).toBe(
    1,
  );
  expect((await getAds("q=")).total).toBe(137);
  expect((await getAds("q=+serum+")).total).toBe(0);
});

it("derives active days from the actual UTC day and keeps inactive days fixed", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const actual = await getAds("q=Quiet+room");
  const after = new Date().toISOString().slice(0, 10);
  expect(
    [today, after].map(
      (date) => (Date.parse(date) - Date.parse("2025-12-02")) / 86400000,
    ),
  ).toContain(actual.data[0].days_active);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-05T23:59:59.999Z"));
    expect((await getAds("q=Quiet+room")).data[0].days_active).toBe(307);
    vi.setSystemTime(new Date("2026-10-06T00:00:00Z"));
    expect((await getAds("q=Quiet+room")).data[0].days_active).toBe(308);
    expect((await getAds("q=Serum+glow")).data[0].days_active).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects missing or unmatched keys with the exact local legacy error", async () => {
  for (const query of ["", "api_key=", "api_key=wrong"]) {
    const response = await fetch(`${origin}/api/v0/ads?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }
});
