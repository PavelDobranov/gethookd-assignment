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
import type { ValidationDetail } from "../src/shared/http-errors.js";
import { readUsage } from "../src/usage/index.js";
import { callTool, connectMcpClient, type ToolOutcome } from "./helpers/mcp-client.js";

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
// Dedicated owners keep the shared-control fixtures isolated: the allowance owner's
// key is driven to its per-key rate limit and the quota owner's meter is driven to
// exhaustion without perturbing the accounting assertions above.
const allowanceKey = "public-mcp-controls-allowance-key";
const quotaKey = "public-mcp-controls-quota-key";

let restServer: Server;
let restOrigin: string;
let mcpApp: McpApp;
let mcpUrl: URL;
let ownerId: string;
let searchKeyAId: string;
let searchKeyBId: string;
let sessionToken: string;
let allowanceOwnerId: string;
let allowanceKeyId: string;
let quotaOwnerId: string;

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

  const [allowanceOwner] = await connection.db
    .insert(users)
    .values({ username: "mcp-controls-allowance-owner", passwordHash: "unused-rest-fixture-hash" })
    .returning({ id: users.id });
  allowanceOwnerId = allowanceOwner.id;
  allowanceKeyId = await insertKey(allowanceOwnerId, allowanceKey, ["search:read"]);

  const [quotaOwner] = await connection.db
    .insert(users)
    .values({ username: "mcp-controls-quota-owner", passwordHash: "unused-rest-fixture-hash" })
    .returning({ id: users.id });
  quotaOwnerId = quotaOwner.id;
  await insertKey(quotaOwnerId, quotaKey, ["search:read"]);

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

/** A direct v0 read; v0 authenticates with the key as a query parameter, not a Bearer header. */
function v0Get(key: string): Promise<Response> {
  return fetch(`${restOrigin}/api/v0/ads?api_key=${encodeURIComponent(key)}`);
}

/** The owner's current authoritative billable-call count for any owner. */
const usageFor = async (owner: string) => (await readUsage(connection.db, owner)).data.billable_calls;

/** How many admissions the key's shared per-key allowance window currently holds. */
async function admissionCount(keyId: string): Promise<number> {
  const { rows } = await connection.db.execute<{ n: number }>(
    sql`SELECT coalesce(cardinality(rate_admissions), 0)::int AS n FROM api_keys WHERE id = ${keyId}::uuid`,
  );
  return rows[0].n;
}

/** Empties the key's allowance window so admission counts start from a known zero. */
function resetAllowance(keyId: string) {
  return connection.db.execute(
    sql`UPDATE api_keys SET rate_admissions = ARRAY[]::timestamptz[] WHERE id = ${keyId}::uuid`,
  );
}

/** Fills the key's 60-slot allowance window so the next admission is denied with a live wait. */
function fillAllowance(keyId: string) {
  return connection.db.execute(
    sql`UPDATE api_keys SET rate_admissions = array_fill(clock_timestamp(), ARRAY[60]) WHERE id = ${keyId}::uuid`,
  );
}

/** Drives the owner's current-month meter to a known count without issuing billable calls. */
function setMonthlyUsage(ownerId: string, count: number) {
  return connection.db.execute(sql`
    INSERT INTO monthly_usage (owner_id, period_start, count)
    VALUES (${ownerId}::uuid, date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date, ${count})
    ON CONFLICT (owner_id, period_start) DO UPDATE SET count = ${count}
  `);
}

/** The whole-second wait REST embeds in a RATE_LIMITED message, matching its Retry-After header. */
function rateWait(message: string): number {
  const match = message.match(/Wait (\d+) seconds/);
  if (!match) throw new Error(`No wait found in rate-limited message: ${message}`);
  return Number(match[1]);
}

/** The error envelope a failed outcome propagated verbatim from REST. */
function errorEnvelope(outcome: ToolOutcome) {
  if (!outcome.isError) throw new Error("Expected a failed tool outcome.");
  return (outcome.body as { error: { code: string; message: string; details: ValidationDetail[] } }).error;
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

describe("mixed v0/v1/MCP traffic consumes one shared per-key allowance", () => {
  // The allowance is the per-key rate window on the api_keys row. v0 (query-credential),
  // v1 (Bearer) and MCP (Bearer forwarded to v1) all admit through the same window, so a
  // valid call on any channel appends exactly one admission to the one key. These tests
  // drive rate_admissions directly rather than issuing 60 real calls, so they are
  // deterministic and never sleep or contend for the window with the suites above.

  it("appends exactly one admission per valid call across all three channels", async () => {
    await resetAllowance(allowanceKeyId);
    const v0 = await v0Get(allowanceKey);
    expect(v0.status).toBe(200);
    const v1 = await restGet(`/api/v1/ads?brand_id=${brandId}`, allowanceKey);
    expect(v1.status).toBe(200);
    const mcp = await callTool(mcpUrl, bearer(allowanceKey), "search_ads", { brand_id: brandId });
    expect(mcp.isError).toBe(false);
    expect(await admissionCount(allowanceKeyId)).toBe(3);
  });

  it("charges allowance for free niche calls and admitted errors but not protocol-only exchanges", async () => {
    await resetAllowance(allowanceKeyId);

    // A protocol-only exchange (connect and discovery) forwards nothing to REST.
    const client = await connectMcpClient(mcpUrl, bearer(allowanceKey));
    await client.listTools();
    await client.close();
    expect(await admissionCount(allowanceKeyId)).toBe(0);

    const beforeMeter = await usageFor(allowanceOwnerId);
    const niches = await callTool(mcpUrl, bearer(allowanceKey), "list_niches");
    expect(niches.isError).toBe(false);
    const missing = await callTool(mcpUrl, bearer(allowanceKey), "get_ad", { id: missingAdId });
    expect(missing).toMatchObject({ isError: true, code: "AD_NOT_FOUND" });

    // Both an unbilled free call and an admitted-then-failed read consumed allowance.
    expect(await admissionCount(allowanceKeyId)).toBe(2);
    expect(await usageFor(allowanceOwnerId)).toBe(beforeMeter);
  });

  it("propagates REST's accurate rate wait through MCP without appending an admission", async () => {
    await fillAllowance(allowanceKeyId);
    const rest = await restGet(`/api/v1/ads?brand_id=${brandId}`, allowanceKey);
    expect(rest.status).toBe(429);
    const restWait = Number(rest.headers.get("retry-after"));
    const restBody = (await rest.json()) as { error: { code: string; message: string } };
    expect(restBody.error.code).toBe("RATE_LIMITED");
    // The Retry-After header and the wait embedded in the body are the one computed value.
    expect(rateWait(restBody.error.message)).toBe(restWait);

    const mcp = await callTool(mcpUrl, bearer(allowanceKey), "search_ads", { brand_id: brandId });
    expect(mcp).toMatchObject({ isError: true, code: "RATE_LIMITED" });
    const mcpWait = rateWait(errorEnvelope(mcp).message);
    // MCP forwarded REST's live wait; it only shrinks as the window ages between the two
    // real calls, never grows and is never dropped or fabricated.
    expect(restWait).toBeGreaterThan(0);
    expect(restWait - mcpWait).toBeGreaterThanOrEqual(0);
    expect(restWait - mcpWait).toBeLessThanOrEqual(1);

    // A denied allowance is not a new admission, on either channel.
    expect(await admissionCount(allowanceKeyId)).toBe(60);
  });
});

describe("an exhausted owner quota blocks new billable MCP successes", () => {
  it("blocks a new billable success with reset guidance while a matching billed retry stays free", async () => {
    // Bill a retry identity at the quota edge, then let that charge exhaust the quota.
    await setMonthlyUsage(quotaOwnerId, 999);
    const retryKey = "quota-free-retry";
    const billed = await callTool(mcpUrl, bearer(quotaKey), "get_ad", { id: adId, idempotency_key: retryKey });
    expect(billed.isError).toBe(false);
    expect(await usageFor(quotaOwnerId)).toBe(1000);

    // A new billable MCP success is refused with QUOTA_EXCEEDED and reset guidance.
    const blocked = await callTool(mcpUrl, bearer(quotaKey), "get_ad", { id: adId });
    expect(blocked).toMatchObject({ isError: true, code: "QUOTA_EXCEEDED" });
    const periodEnd = (await readUsage(connection.db, quotaOwnerId)).data.period_end;
    const error = errorEnvelope(blocked);
    expect(error.message).toContain(`resets at ${periodEnd}`);
    expect(error.details[0]).toMatchObject({
      parameter: "quota",
      reason: "monthly_quota_exceeded",
      suggestion: periodEnd,
    });
    expect(await usageFor(quotaOwnerId)).toBe(1000);

    // The existing matching billed retry still deduplicates for free.
    const retry = await callTool(mcpUrl, bearer(quotaKey), "get_ad", { id: adId, idempotency_key: retryKey });
    expect(retry.isError).toBe(false);
    expect(await usageFor(quotaOwnerId)).toBe(1000);
  });

  it("still passes free and read checks under an exhausted quota", async () => {
    await setMonthlyUsage(quotaOwnerId, 1000);

    // A free operation is never metered, so an exhausted quota never blocks it.
    const niches = await callTool(mcpUrl, bearer(quotaKey), "list_niches");
    expect(niches.isError).toBe(false);

    // The read executes before settlement, so a missing ad fails its own read check,
    // not the quota check, and never charges.
    const missing = await callTool(mcpUrl, bearer(quotaKey), "get_ad", { id: missingAdId });
    expect(missing).toMatchObject({ isError: true, code: "AD_NOT_FOUND" });
    expect(await usageFor(quotaOwnerId)).toBe(1000);
  });
});
