import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createApiClient } from "../../mcp/src/api-client.js";
import { createMcpApp, type McpApp } from "../../mcp/src/transport.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { readUsage } from "../src/usage/index.js";
import { callTool, type ToolOutcome } from "./helpers/mcp-client.js";

// Mixed-channel accounting through the real HTTP boundaries: a real MCP client
// talks to a real MCP server, which forwards each caller's Bearer credential and
// supplied idempotency identity to a real REST API over isolated PostgreSQL. REST
// stays the single meter and the sole deduplication authority; this suite proves
// that one billing namespace spans both channels. M4's own suites remain the
// authority for exhaustive 24-hour, month and recovery boundaries; here we only
// prove the MCP/REST mapping reuses that one mechanism rather than a second meter.
const jwtSecret = "public-mcp-controls-integration-jwt-secret-32-bytes";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_mcp_controls_test";
const connection = createDatabase(url.href);

const brandId = 95001;
const freshBrandId = 95002;
const adId = "mcp-controls-ad-1";
const otherAdId = "mcp-controls-ad-2";
const freshAdId = "mcp-controls-fresh-ad";
const missingAdId = "mcp-controls-missing-ad";
const originalFreshHeadline = "Fresh read original headline";
const updatedFreshHeadline = "Fresh read updated headline";

const searchKeyA = "public-mcp-controls-search-a-key";
const searchKeyB = "public-mcp-controls-search-b-key";
const manageKey = "public-mcp-controls-keys-manage-key";

let restServer: Server;
let restOrigin: string;
let mcpApp: McpApp;
let mcpUrl: URL;
let ownerId: string;
let searchKeyAId: string;
let searchKeyBId: string;
let sessionToken: string;

async function insertKey(userId: string, secret: string, scopes: string[]): Promise<string> {
  const [row] = await connection.db
    .insert(apiKeys)
    .values({ userId, keyHash: hashApiKey(secret), prefix: secret.slice(0, 12), scopes })
    .returning({ id: apiKeys.id });
  return row.id;
}

function seedAd(id: string, brand: number, headline: string, discoveredAt: string, impressionRank: number) {
  return connection.db.insert(ads).values({
    id,
    brandId: brand,
    headline,
    bodyText: "A real ad fixture for mixed-channel accounting checks.",
    niche: "skincare",
    format: "video",
    status: "active",
    startDate: "2026-01-02",
    endDate: null,
    impressionRank,
    countries: ["US"],
    discoveredAt: new Date(discoveredAt),
  });
}

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_mcp_controls_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);

  await connection.db.insert(brands).values([
    { id: brandId, name: "Mixed Channel Brand" },
    { id: freshBrandId, name: "Fresh Read Brand" },
  ]);
  // Three ads in one brand give limit=1 searches a non-null continuation cursor.
  // Ranks are unique within a brand (ads_brand_rank_unique).
  await seedAd(adId, brandId, "Serum launch", "2026-01-03Z", 1);
  await seedAd(otherAdId, brandId, "Cleanser restock", "2026-01-02Z", 2);
  await seedAd("mcp-controls-ad-3", brandId, "Toner drop", "2026-01-01Z", 3);
  // A dedicated ad in its own brand so the fresh-read mutation never perturbs the
  // deterministic three-ad pagination fixture above.
  await seedAd(freshAdId, freshBrandId, originalFreshHeadline, "2026-01-04Z", 1);

  const [owner] = await connection.db
    .insert(users)
    .values({ username: "mcp-controls-owner", passwordHash: "unused-rest-fixture-hash" })
    .returning({ id: users.id });
  ownerId = owner.id;
  searchKeyAId = await insertKey(ownerId, searchKeyA, ["search:read"]);
  searchKeyBId = await insertKey(ownerId, searchKeyB, ["search:read"]);
  await insertKey(ownerId, manageKey, ["keys:manage"]);
  sessionToken = await signToken(ownerId, jwtSecret);

  restServer = createApp({ db: connection.db, jwtSecret }).listen(0, "127.0.0.1");
  await once(restServer, "listening");
  restOrigin = `http://127.0.0.1:${(restServer.address() as AddressInfo).port}`;

  mcpApp = createMcpApp({ apiClient: createApiClient({ baseUrl: restOrigin }) });
  await new Promise<void>((resolve) => mcpApp.server.listen(0, "127.0.0.1", resolve));
  mcpUrl = new URL(`http://127.0.0.1:${(mcpApp.server.address() as AddressInfo).port}/mcp`);
});

afterAll(async () => {
  await mcpApp?.close();
  if (restServer)
    await new Promise<void>((resolve, reject) => restServer.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

const bearer = (secret: string) => `Bearer ${secret}`;

/** The owner's current authoritative billable-call count, read straight from the meter. */
const meter = async () => (await readUsage(connection.db, ownerId)).data.billable_calls;

/** How many deduplication bindings currently exist for one API key. */
async function bindingCount(keyId: string): Promise<number> {
  const { rows } = await connection.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM billing_bindings WHERE api_key_id = ${keyId}::uuid`,
  );
  return rows[0].n;
}

/** A direct REST read that carries the idempotency identity only as the HTTP header. */
function restGet(path: string, key: string, idempotencyKey?: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: bearer(key) };
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  return fetch(`${restOrigin}${path}`, { headers });
}

describe("billable reads charge once per channel; free and failed reads never charge", () => {
  it("charges a successful MCP search", async () => {
    const before = await meter();
    const outcome = await callTool(mcpUrl, bearer(searchKeyA), "search_ads", { brand_id: brandId });
    expect(outcome.isError).toBe(false);
    expect(await meter()).toBe(before + 1);
  });

  it("charges a successful MCP detail read", async () => {
    const before = await meter();
    const outcome = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: adId });
    expect(outcome.isError).toBe(false);
    expect(await meter()).toBe(before + 1);
  });

  it("charges an empty search that matches nothing", async () => {
    const before = await meter();
    const outcome = await callTool(mcpUrl, bearer(searchKeyA), "search_ads", { q: "zzz-no-such-ad-xyzzy" });
    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    expect((outcome.body as { data: unknown[] }).data).toHaveLength(0);
    expect(await meter()).toBe(before + 1);
  });

  it("charges each cursor page independently", async () => {
    const before = await meter();
    const page1 = await callTool(mcpUrl, bearer(searchKeyA), "search_ads", { brand_id: brandId, limit: 1 });
    expect(page1.isError).toBe(false);
    if (page1.isError) return;
    const cursor = (page1.body as { next_cursor: string | null }).next_cursor;
    expect(cursor).not.toBeNull();
    const page2 = await callTool(mcpUrl, bearer(searchKeyA), "search_ads", { cursor: cursor as string });
    expect(page2.isError).toBe(false);
    expect(await meter()).toBe(before + 2);
  });

  it("never charges list_niches", async () => {
    const before = await meter();
    const outcome = await callTool(mcpUrl, bearer(searchKeyA), "list_niches");
    expect(outcome.isError).toBe(false);
    expect(await meter()).toBe(before);
  });

  it("never charges a failed detail read", async () => {
    const before = await meter();
    const outcome = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: missingAdId });
    expect(outcome).toMatchObject({ isError: true, code: "AD_NOT_FOUND" });
    expect(await meter()).toBe(before);
  });

  it("charges equal no-header successes separately across channels", async () => {
    const before = await meter();
    const rest = await restGet(`/api/v1/ads?brand_id=${brandId}`, searchKeyA);
    expect(rest.status).toBe(200);
    const mcp = await callTool(mcpUrl, bearer(searchKeyA), "search_ads", { brand_id: brandId });
    expect(mcp.isError).toBe(false);
    expect(await meter()).toBe(before + 2);
  });

  it("agrees between the authoritative API and portal usage reads and the meter", async () => {
    const api = await fetch(`${restOrigin}/api/v1/usage`, { headers: { Authorization: bearer(manageKey) } });
    const portal = await fetch(`${restOrigin}/api/portal/usage`, { headers: { Authorization: bearer(sessionToken) } });
    expect(api.status).toBe(200);
    expect(portal.status).toBe(200);
    const apiBody = await api.json();
    expect(await portal.json()).toEqual(apiBody);
    expect(apiBody.data.billable_calls).toBe(await meter());
  });
});

describe("supplied identities deduplicate across REST and MCP within one key", () => {
  it("deduplicates a REST charge then an MCP retry on the same key", async () => {
    const beforeMeter = await meter();
    const beforeBindings = await bindingCount(searchKeyAId);
    const rest = await restGet(`/api/v1/ads/${adId}`, searchKeyA, "dedup-rest-first");
    expect(rest.status).toBe(200);
    const mcp = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: adId, idempotency_key: "dedup-rest-first" });
    expect(mcp.isError).toBe(false);
    expect(await meter()).toBe(beforeMeter + 1);
    expect(await bindingCount(searchKeyAId)).toBe(beforeBindings + 1);
  });

  it("deduplicates an MCP charge then a REST retry on the same key", async () => {
    const beforeMeter = await meter();
    const beforeBindings = await bindingCount(searchKeyAId);
    const mcp = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: adId, idempotency_key: "dedup-mcp-first" });
    expect(mcp.isError).toBe(false);
    const rest = await restGet(`/api/v1/ads/${adId}`, searchKeyA, "dedup-mcp-first");
    expect(rest.status).toBe(200);
    expect(await meter()).toBe(beforeMeter + 1);
    expect(await bindingCount(searchKeyAId)).toBe(beforeBindings + 1);
  });

  it("settles a synchronized concurrent cohort exactly once across channels", async () => {
    const beforeMeter = await meter();
    const beforeBindings = await bindingCount(searchKeyAId);
    const key = "cohort-mixed";
    const results = await Promise.all<Response | ToolOutcome>([
      restGet(`/api/v1/ads/${adId}`, searchKeyA, key),
      restGet(`/api/v1/ads/${adId}`, searchKeyA, key),
      restGet(`/api/v1/ads/${adId}`, searchKeyA, key),
      callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: adId, idempotency_key: key }),
      callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: adId, idempotency_key: key }),
      callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: adId, idempotency_key: key }),
    ]);
    for (const result of results) {
      if (result instanceof Response) expect(result.status).toBe(200);
      else expect(result.isError).toBe(false);
    }
    expect(await meter()).toBe(beforeMeter + 1);
    expect(await bindingCount(searchKeyAId)).toBe(beforeBindings + 1);
  });

  it("conflicts a changed request that reuses an identity, on both channels", async () => {
    const before = await meter();
    const key = "conflict-shared";
    const first = await restGet(`/api/v1/ads/${adId}`, searchKeyA, key);
    expect(first.status).toBe(200);
    const mcpConflict = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: otherAdId, idempotency_key: key });
    expect(mcpConflict).toMatchObject({ isError: true, code: "IDEMPOTENCY_CONFLICT" });
    const restConflict = await restGet(`/api/v1/ads/${otherAdId}`, searchKeyA, key);
    expect(restConflict.status).toBe(409);
    expect((await restConflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await meter()).toBe(before + 1);
  });

  it("keeps different keys in independent identity namespaces", async () => {
    const beforeMeter = await meter();
    const beforeA = await bindingCount(searchKeyAId);
    const beforeB = await bindingCount(searchKeyBId);
    const key = "namespace-shared";
    const viaA = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: adId, idempotency_key: key });
    expect(viaA.isError).toBe(false);
    const viaB = await restGet(`/api/v1/ads/${adId}`, searchKeyB, key);
    expect(viaB.status).toBe(200);
    expect(await meter()).toBe(beforeMeter + 2);
    expect(await bindingCount(searchKeyAId)).toBe(beforeA + 1);
    expect(await bindingCount(searchKeyBId)).toBe(beforeB + 1);
  });
});

describe("header-only propagation, fresh reads and no implicit MCP identity", () => {
  // The cross-channel dedup above already proves the MCP idempotency_key argument
  // travels to REST only as the Idempotency-Key header (a REST header retry
  // deduplicates an MCP-supplied identity and vice versa); the key never enters a
  // URL or tool-response payload.

  it("returns current data for a deduplicated retry without charging", async () => {
    const key = "fresh-read-identity";
    const first = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: freshAdId, idempotency_key: key });
    expect(first.isError).toBe(false);
    if (first.isError) return;
    expect((first.body as { data: { headline: string } }).data.headline).toBe(originalFreshHeadline);

    const before = await meter();
    await connection.db.update(ads).set({ headline: updatedFreshHeadline }).where(eq(ads.id, freshAdId));

    const retry = await callTool(mcpUrl, bearer(searchKeyA), "get_ad", { id: freshAdId, idempotency_key: key });
    expect(retry.isError).toBe(false);
    if (retry.isError) return;
    expect((retry.body as { data: { headline: string } }).data.headline).toBe(updatedFreshHeadline);
    expect(await meter()).toBe(before);
  });

  it("derives no implicit identity for MCP calls that supply no key", async () => {
    const beforeMeter = await meter();
    const beforeBindings = await bindingCount(searchKeyAId);
    const first = await callTool(mcpUrl, bearer(searchKeyA), "search_ads", { brand_id: brandId });
    const second = await callTool(mcpUrl, bearer(searchKeyA), "search_ads", { brand_id: brandId });
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(await meter()).toBe(beforeMeter + 2);
    expect(await bindingCount(searchKeyAId)).toBe(beforeBindings);
  });
});
