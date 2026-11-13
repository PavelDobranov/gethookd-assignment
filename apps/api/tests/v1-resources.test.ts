import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { niches } from "../src/ads/model.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_resources_test";
const connection = createDatabase(url.href);
const publicKey = "public-v1-resource-test-key";
let key: string;
let caseNumber = 0;
const jwtSecret = "public-v1-resource-jwt-secret-32-bytes";
let server: Server;
let origin: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v1_resources_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  server = createApp({ db: connection.db, jwtSecret }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

// Fresh identities isolate allowance/quota state; auth-mutation cases retain one key.
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

function request(path = "/niches", authorization: string | null = `Bearer ${key}`) {
  return fetch(`${origin}/api/v1${path}`, {
    headers: authorization === null ? {} : { Authorization: authorization },
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error).toEqual({
    code,
    message: expect.any(String),
    next_action: expect.any(String),
    retryable: status === 500,
    details: expect.any(Array),
  });
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.next_action.length).toBeGreaterThan(0);
  return body.error;
}

const detailId = "v1-detail-active";
const detailBrand = 90001;

it("returns the full active detail allowlist from current joined data", async () => {
  await connection.db.insert(brands).values({ id: detailBrand, name: "Detail Brand" });
  await connection.db.insert(ads).values({
    id: detailId,
    brandId: detailBrand,
    headline: "Detail headline",
    bodyText: "Full untruncated body",
    niche: "pet-supplies",
    format: "carousel",
    status: "active",
    startDate: "2026-01-01",
    endDate: null,
    impressionRank: null,
    countries: ["US", "GB"],
    discoveredAt: new Date("2026-01-02T03:04:05.123Z"),
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-03T23:59:59.999Z"));
  try {
    const response = await request(`/ads/${detailId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      data: {
        id: detailId,
        brand_id: detailBrand,
        brand_name: "Detail Brand",
        headline: "Detail headline",
        body_text: "Full untruncated body",
        niche: "pet-supplies",
        format: "carousel",
        status: "active",
        start_date: "2026-01-01",
        end_date: null,
        days_active: 2,
        impression_rank: null,
        countries: ["US", "GB"],
        discovered_at: "2026-01-02T03:04:05.123Z",
      },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("returns actionable AD_NOT_FOUND for a well-formed absent ID", async () => {
  const error = await expectError(await request("/ads/absent-opaque-id"), 404, "AD_NOT_FOUND");
  expect(error.details).toEqual([]);
  expect(error.next_action).toMatch(/ID|search/);
});

it.each(["?q=serum", "?status=active", "?cursor=sentinel", "?api_key=sentinel", "?x=1&x=2"])(
  "rejects detail query parameters before looking up even a missing ID: %s",
  async (query) => {
    await expectError(await request(`/ads/absent-opaque-id${query}`), 422, "VALIDATION_ERROR");
  },
);

it.each(["opaque /?# + café", "%FF", "000123", " quote' OR 1=1 -- "])(
  "looks up the exact once-decoded opaque ID: %s",
  async (id) => {
    const [source] = await connection.db.select().from(ads).where(eq(ads.id, detailId));
    await connection.db.insert(ads).values({ ...source, id, headline: "Encoded ID fixture", impressionRank: null });
    const response = await request(`/ads/${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.id).toBe(id);
    await expectError(await request(`/ads/${encodeURIComponent(`${id}-missing`)}`), 404, "AD_NOT_FOUND");
  },
);

it("rejects a decoded NUL as input rather than a database failure", async () => {
  const error = await expectError(await request("/ads/bad%00id"), 422, "VALIDATION_ERROR");
  expect(error.details).toEqual([{ parameter: "id", reason: "invalid_text", allowed_values: [], suggestion: null }]);
});

it("agrees with v0 across UTC midnight and after deactivation using current joined data", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (const [clock, expectedDays] of [
      ["2026-01-03T23:59:59.999Z", 2],
      ["2026-01-04T00:00:00.000Z", 3],
    ] as const) {
      vi.setSystemTime(new Date(clock));
      const detail = await (await request(`/ads/${detailId}`)).json();
      const legacy = await (await fetch(`${origin}/api/v0/ads?api_key=${key}&q=Detail%20headline`)).json();
      expect(legacy.data).toHaveLength(1);
      expect(detail.data.days_active).toBe(expectedDays);
      expect(legacy.data[0].days_active).toBe(detail.data.days_active);
    }
    await connection.db
      .update(ads)
      .set({ status: "inactive", endDate: "2026-01-02", impressionRank: 1 })
      .where(eq(ads.id, detailId));
    await connection.db.update(brands).set({ name: "Current Detail Brand" }).where(eq(brands.id, detailBrand));
    for (const clock of ["2026-01-04T23:59:59.999Z", "2026-01-05T00:00:00.000Z"]) {
      vi.setSystemTime(new Date(clock));
      const response = await request(`/ads/${detailId}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        data: {
          id: detailId,
          brand_id: detailBrand,
          brand_name: "Current Detail Brand",
          headline: "Detail headline",
          body_text: "Full untruncated body",
          niche: "pet-supplies",
          format: "carousel",
          status: "inactive",
          start_date: "2026-01-01",
          end_date: "2026-01-02",
          days_active: 1,
          impression_rank: 1,
          countries: ["US", "GB"],
          discovered_at: "2026-01-02T03:04:05.123Z",
        },
      });
      const legacy = await (await fetch(`${origin}/api/v0/ads?api_key=${key}&q=Detail%20headline`)).json();
      expect(legacy.data).toHaveLength(1);
      expect(legacy.data[0].days_active).toBe(1);
      expect(legacy.data[0].status).toBe("inactive");
    }
  } finally {
    vi.useRealTimers();
  }
});

it("returns a sanitized 500 when the detail query fails after successful authentication", async () => {
  const logs = ["error", "warn", "log", "info"] as const;
  const spies = logs.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  const failure = vi.spyOn(connection.db, "select").mockImplementationOnce(() => {
    throw new Error(`SELECT inserted_xid credential-sentinel ${key}`);
  });
  try {
    const error = await expectError(await request(`/ads/${detailId}`), 500, "INTERNAL_ERROR");
    expect(error.details).toEqual([]);
    expect(JSON.stringify(error)).not.toMatch(/SELECT|inserted_xid|sentinel|public-v1/);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    failure.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
});

it("returns exactly the existing ordered slug/name catalog and accepts the same key as v0", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ data: niches.map(({ slug, name }) => ({ slug, name })) });
  expect(niches).toHaveLength(12);
  for (const storedKey of [key, "gethookd-public-demo-api-key-m2"]) {
    expect((await request("/niches", `Bearer ${storedKey}`)).status).toBe(200);
    const legacy = await fetch(`${origin}/api/v0/ads?api_key=${storedKey}&per_page=1`);
    expect(legacy.status).toBe(200);
  }
});

it.each([
  null,
  "",
  "Basic invalid",
  "Bearer",
  "Bearer ",
  "Bearer invalid",
  `Bearer ${publicKey} extra`,
  `Bearer ${publicKey},${publicKey}`,
])("rejects missing, malformed or invalid credentials: %s", async (authorization) => {
  const currentAuthorization = authorization === null ? null : authorization.replaceAll(publicKey, key);
  const error = await expectError(await request("/niches", currentAuthorization), 401, "UNAUTHENTICATED");
  expect(error.details).toEqual([]);
  expect(error.next_action).toContain("Bearer");
});

it("rejects query-key-only and portal JWT substitution", async () => {
  await expectError(await request(`/niches?api_key=${key}`, null), 401, "UNAUTHENTICATED");
  const jwt = await new SignJWT({ sub: "1" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
  await expectError(await request("/niches", `Bearer ${jwt}`), 401, "UNAUTHENTICATED");
});

it.each([
  "?api_key=credential-sentinel",
  "?niche=skincare",
  "?limit=1",
  "?niche[]=skincare",
  "?x=1&x=2",
  "?=x",
  "??limit=1",
  "?&?api_key=credential-sentinel",
])("rejects all supplied niche query names: %s", async (query) => {
  const error = await expectError(await request(`/niches${query}`), 422, "VALIDATION_ERROR");
  expect(error.details).toEqual([
    { parameter: "query", reason: "unknown_parameter", allowed_values: [], suggestion: null },
  ]);
});

it.each(["/niches?bad=1", `/ads/${detailId}`, "/ads/missing?bad=1", "/ads/%E0%A4%A", "/missing"])(
  "authenticates before disclosing diagnostics: %s",
  async (path) => {
    await expectError(await request(path, null), 401, "UNAUTHENTICATED");
  },
);

it.each(["/ads/%E0%A4%A", "/ads/%FF", "/niches/%ZZ"])("isolates malformed paths: %s", async (path) => {
  const error = await expectError(await request(path), 422, "VALIDATION_ERROR");
  expect(error.details).toEqual([
    { parameter: "path", reason: "malformed_encoding", allowed_values: [], suggestion: null },
  ]);
});

it.each(["/missing", "/", "/ads/unknown/route", "/niches/extra"])("isolates unknown routes: %s", async (path) => {
  const error = await expectError(await request(path), 404, "NOT_FOUND");
  expect(error.details).toEqual([]);
});

it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("returns structured 404 for unsupported %s", async (method) => {
  const response = await fetch(`${origin}/api/v1/niches`, { method, headers: { Authorization: `Bearer ${key}` } });
  await expectError(response, 404, "NOT_FOUND");
});

it("does not implicitly expose GET through HEAD", async () => {
  const response = await fetch(`${origin}/api/v1/niches`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.text()).toBe(""); // HTTP HEAD has no response body.
});

it("rejects duplicate Authorization headers even when Node would discard one", async () => {
  const result = await new Promise<{ status: number | undefined; body: string; cache: string | undefined }>(
    (resolve, reject) => {
      const req = httpRequest(
        `${origin}/api/v1/niches`,
        {
          headers: ["Host", new URL(origin).host, "Authorization", `Bearer ${key}`, "Authorization", `Bearer ${key}`],
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, body, cache: res.headers["cache-control"] }));
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  expect(result.status).toBe(401);
  expect(result.cache).toBe("no-store");
  expect(JSON.parse(result.body).error.code).toBe("UNAUTHENTICATED");
});

it("keeps injected database failures as sanitized 500s without logging raw diagnostics", async () => {
  const logs = ["error", "warn", "log", "info"] as const;
  const spies = logs.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  const failure = vi
    .spyOn(connection.db.$client, "connect")
    .mockRejectedValueOnce(new Error(`SELECT credential-sentinel ${key} cursor-sentinel`));
  try {
    const error = await expectError(await request("/niches?cursor=cursor-sentinel"), 500, "INTERNAL_ERROR");
    expect(error.details).toEqual([]);
    expect(JSON.stringify(error)).not.toMatch(/SELECT|sentinel|public-v1/);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    failure.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
  expect((await request()).status).toBe(200);
});

it("consults stored keys again on the very next request", async () => {
  expect((await request()).status).toBe(200);
  await connection.db
    .update(apiKeys)
    .set({ keyHash: hashApiKey(`${key}-changed`) })
    .where(eq(apiKeys.keyHash, hashApiKey(key)));
  try {
    await expectError(await request(), 401, "UNAUTHENTICATED");
    await expectError(await request(`/ads/${detailId}`), 401, "UNAUTHENTICATED");
    expect((await request("/niches", `Bearer ${key}-changed`)).status).toBe(200);
    expect((await request(`/ads/${detailId}`, `Bearer ${key}-changed`)).status).toBe(200);
  } finally {
    await connection.db
      .update(apiKeys)
      .set({ keyHash: hashApiKey(key) })
      .where(eq(apiKeys.keyHash, hashApiKey(`${key}-changed`)));
  }
});
