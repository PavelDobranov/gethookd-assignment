import { once } from "node:events";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { niches } from "../src/ads/model.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v0_test";
const connection = createDatabase(url.href);
const publicKey = "public-v0-test-key";
let key: string;
let caseNumber = 0;
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
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

// Fresh identities isolate allowance/quota state; multi-call cases retain one key.
beforeEach(async () => {
  key = `${publicKey}-${++caseNumber}`;
  const [owner] = await connection.db
    .insert(users)
    .values({
      username: key,
      passwordHash: "unused-rest-fixture-hash",
    })
    .returning({ id: users.id });
  await connection.db.insert(apiKeys).values(apiKeyFixture(owner.id, hashApiKey(key), key.slice(0, 12)));
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

it("serves only the legacy allowlisted fields using a stored key", async () => {
  const response = await fetch(`${origin}/api/v0/ads?api_key=${key}&q=Serum+glow`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
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
  ["q=serum&status=inactive", ["contract-ad", "tie-ad"]],
  ["q=serum&format=image", ["body-ad", "tie-ad"]],
  ["q=proof&format=carousel", ["literal-ad"]],
  ["q=serum&niche=Pet+Supplies&format=video&status=active", ["pet-ad"]],
  ["q=serum&niche=skincare&format=image", []],
  ["q=missing", []],
  ["q=%25", ["literal-ad"]],
  ["q=_", ["literal-ad"]],
  ["q=%5C", ["literal-ad"]],
  ["q=%25_%5C", ["literal-ad"]],
  ["q=%27+OR+1%3D1+--", []],
])("applies parameterized literal search and combined filters: %s", async (query, ids) => {
  const body = await getAds(query);
  expect(body.total).toBe(ids.length);
  expect(body.data.map((ad: { id: string }) => ad.id).sort()).toEqual([...ids].sort());
});

it("returns default and clamped offset pages with full totals and date-only descending order", async () => {
  const first = await getAds();
  expect(first.page).toBe(1);
  expect(first.total).toBe(137);
  expect(first.data).toHaveLength(20);
  const dates = first.data.map((ad: { start_date: string }) => ad.start_date);
  expect(dates).toEqual([...dates].sort().reverse());
  expect(new Set(first.data.slice(3, 5).map((ad: { id: string }) => ad.id))).toEqual(new Set(["pet-ad", "tie-ad"]));
  const clamped = await getAds("per_page=101");
  expect(clamped.data).toHaveLength(100);
  const second = await getAds("page=2&per_page=9007199254740991");
  expect(second.page).toBe(2);
  expect(second.total).toBe(137);
  expect(second.data).toHaveLength(37);
  expect(await getAds("page=200")).toEqual({ data: [], page: 200, total: 137 });
  const filtered = await getAds("q=serum&page=2&per_page=2");
  expect(filtered.page).toBe(2);
  expect(filtered.total).toBe(4);
  expect(filtered.data.map((ad: { id: string }) => ad.id).sort()).toEqual(["pet-ad", "tie-ad"]);
  expect(await getAds("q=serum&page=3&per_page=2")).toEqual({
    data: [],
    page: 3,
    total: 4,
  });
  expect((await getAds("page=0002&per_page=003")).data).toHaveLength(3);
});

it.each(niches)("accepts slug/display names without losing $name in the response", async ({ slug, name }) => {
  for (const niche of [slug, name, slug.toUpperCase(), name.toUpperCase()]) {
    const body = await getAds(new URLSearchParams({ q: "Catalog", niche }).toString());
    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].niche).toBe(name);
  }
});

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
])("ignores invalid filter while retaining valid combined filters: %s", async (invalid) => {
  const valid = invalid.startsWith("niche")
    ? "format=video&status=inactive"
    : invalid.startsWith("format")
      ? "niche=skincare&status=inactive"
      : "niche=skincare&format=video";
  const body = await getAds(`q=serum&${valid}&${invalid}`);
  expect(body.total).toBe(1);
  expect(body.data.map((ad: { id: string }) => ad.id)).toEqual(["contract-ad"]);
});

it("ignores exact-name mismatches, repeated unknowns, sort and bracketed names", async () => {
  const body = await getAds(
    "q=serum&niche[x]=bad&niche[x]=worse&sort=asc&sort=desc&other=1&other=2&Q=missing&Q=absent&api_key[]=bad&page[]=bad&per_page[x]=bad",
  );
  expect(body.total).toBe(4);
  expect(body.data.map((ad: { id: string }) => ad.id).sort()).toEqual(["body-ad", "contract-ad", "pet-ad", "tie-ad"]);
  expect((await getAds("q=serum&niche=skincare&niche[x]=fitness")).total).toBe(1);
  expect((await getAds("q=")).total).toBe(137);
  expect((await getAds("q=+serum+")).total).toBe(0);
});

it("derives active days from the actual UTC day and keeps inactive days fixed", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const actual = await getAds("q=Quiet+room");
  const after = new Date().toISOString().slice(0, 10);
  expect([today, after].map((date) => (Date.parse(date) - Date.parse("2025-12-02")) / 86400000)).toContain(
    actual.data[0].days_active,
  );
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

async function expectInvalid(query: string, headers?: HeadersInit) {
  const response = await fetch(`${origin}/api/v0/ads?${query}`, { headers });
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Invalid request" });
}

it.each([
  "",
  "api_key=",
  "api_key=wrong",
  "api_key[]=wrong",
  "api_key[x]=wrong",
  "API_KEY=wrong",
  `api_key=+${publicKey}+`,
  `api_key=${publicKey.toUpperCase()}`,
  "api_key=%27+OR+1%3D1+--",
])("rejects missing or unmatched scalar keys: %s", async (query) => {
  // Apply malformed variants to this case's real credential, not an unknown key.
  await expectInvalid(query.replaceAll(publicKey.toUpperCase(), key.toUpperCase()).replaceAll(publicKey, key));
});

for (const name of ["page", "per_page"]) {
  it.each([
    "",
    "0",
    "000",
    "-1",
    "1.5",
    "1.0",
    "1e2",
    "0x10",
    "NaN",
    "Infinity",
    "abc",
    "2tail",
    "+1",
    " 1",
    "1 ",
    "1\n",
    "１",
    "9007199254740992",
    "9007199254740993",
    "99999999999999999999999999999999999999999999",
  ])(`rejects invalid ${name}=%j over HTTP`, async (value) => {
    await expectInvalid(new URLSearchParams({ api_key: key, [name]: value }).toString());
  });
}

it.each([
  "page=90071992547411&per_page=100",
  "page=9007199254740991",
  "page=3002399751580332&per_page=3",
  "page=90071992547411&per_page=9007199254740991",
])("rejects unsafe clamped offsets: %s", async (query) => {
  await expectInvalid(`api_key=${key}&${query}`);
});

it.each([
  ["per_page=1", 1, 1],
  ["page=3&per_page=100", 3, 0],
  ["page=3&per_page=101", 3, 0],
  ["page=9007199254740991&per_page=1", 9007199254740991, 0],
  ["page=90071992547410&per_page=101", 90071992547410, 0],
  ["page=3002399751580331&per_page=3", 3002399751580331, 0],
])("accepts safe pagination boundaries: %s", async (query, page, length) => {
  const body = await getAds(query);
  expect(body.page).toBe(page);
  expect(body.total).toBe(137);
  expect(body.data).toHaveLength(length);
});

it.each(["q", "niche", "format", "status", "page", "per_page", "api_key"])(
  "rejects duplicate recognized %s including empty and encoded names",
  async (name) => {
    for (const values of [
      ["", ""],
      ["a", "b"],
      ["", "a"],
      ["a", "a"],
      ...(name === "api_key"
        ? [
            [key, key],
            [key, "wrong"],
            ["wrong", key],
            [key, ""],
            ["", key],
          ]
        : []),
    ]) {
      const query = new URLSearchParams();
      if (name !== "api_key") query.append("api_key", key);
      for (const value of values) query.append(name, value);
      await expectInvalid(query.toString());
    }
    const encodedName = `%${name.charCodeAt(0).toString(16)}${name.slice(1)}`;
    const credential = name === "api_key" ? "" : `api_key=${key}&`;
    const value = name === "api_key" ? key : "1";
    await expectInvalid(`${credential}${name}=${value}&${encodedName}=${value}`);
  },
);

it("ignores all bracketed and case-mismatched names, even when repeated", async () => {
  const query = new URLSearchParams({ q: "serum" });
  for (const name of ["q", "niche", "format", "status", "page", "per_page", "api_key"]) {
    for (const unknown of [`${name}[]`, `${name}[x]`, name.toUpperCase()]) {
      query.append(unknown, "bad");
      query.append(unknown, "worse");
    }
  }
  const body = await getAds(query.toString());
  expect(body.page).toBe(1);
  expect(body.total).toBe(4);
  expect(body.data.map((ad: { id: string }) => ad.id).sort()).toEqual(["body-ad", "contract-ad", "pet-ad", "tie-ad"]);
});

it("does not allow a genuine portal JWT to substitute for a stored query key", async () => {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "demo", password: "demo-password" }),
  });
  expect(response.status).toBe(200);
  const { token } = await response.json();
  const headers = { authorization: `Bearer ${token}` };
  await expectInvalid("", headers);
  await expectInvalid("api_key=wrong", headers);
  await expectInvalid(new URLSearchParams({ api_key: token }).toString(), headers);
  const valid = await fetch(`${origin}/api/v0/ads?api_key=${key}&q=missing`, {
    headers: { authorization: "Bearer invalid-portal-token" },
  });
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ data: [], page: 1, total: 0 });
});

it("validates stored-key state on every request rather than caching credentials", async () => {
  const transientKey = "public-v0-transient-key";
  const query = new URLSearchParams({
    api_key: transientKey,
    q: "missing",
  }).toString();
  await expectInvalid(query);
  const [demo] = await connection.db.select().from(users).where(eq(users.username, "demo"));
  const keyHash = hashApiKey(transientKey);
  try {
    await connection.db.insert(apiKeys).values(apiKeyFixture(demo.id, keyHash, transientKey.slice(0, 12)));
    const response = await fetch(`${origin}/api/v0/ads?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], page: 1, total: 0 });
  } finally {
    await connection.db.delete(apiKeys).where(eq(apiKeys.keyHash, keyHash));
  }
  await expectInvalid(query);
});

it.each(["api_keys", "ads", "brands"])(
  "maps real PostgreSQL %s failures to the local legacy error and recovers",
  async (table) => {
    // Break auth, filtered count, then row lookup in this test-owned database only.
    const unavailable = `${table}_unavailable`;
    await connection.db.execute(sql`ALTER TABLE ${sql.identifier(table)} RENAME TO ${sql.identifier(unavailable)}`);
    try {
      await expectInvalid(`api_key=${key}`);
    } finally {
      await connection.db.execute(sql`ALTER TABLE ${sql.identifier(unavailable)} RENAME TO ${sql.identifier(table)}`);
    }
    expect((await getAds("q=missing")).total).toBe(0);
  },
);

it("keeps application output silent for sentinel keys, raw query data and credential-bearing failures", async () => {
  const output = [
    vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ...(["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    ),
  ];
  const select = connection.db.select.bind(connection.db);
  try {
    await getAds("q=public-v0-search-sentinel");
    await expectInvalid("api_key=public-v0-invalid-key-sentinel");
    await expectInvalid(`api_key=${key}&page=bad`);
    // Inject credential-bearing errors at auth, count and row-query boundaries.
    for (const successfulSelects of [0, 1, 2]) {
      const failure = vi.spyOn(connection.db, "select");
      for (let index = 0; index < successfulSelects; index++) {
        failure.mockImplementationOnce(select);
      }
      failure.mockImplementationOnce(() => {
        throw new Error(
          `public-v0-raw-error-sentinel postgresql://public-user:public-password@localhost/test /api/v0/ads?api_key=${key}&q=public-v0-search-sentinel`,
        );
      });
      try {
        await expectInvalid(`api_key=${key}&q=public-v0-search-sentinel`);
      } finally {
        failure.mockRestore();
      }
    }
    for (const sink of output) expect(sink).not.toHaveBeenCalled();
  } finally {
    for (const sink of output) sink.mockRestore();
  }
});
