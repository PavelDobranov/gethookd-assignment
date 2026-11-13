import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createApiClient } from "../../mcp/src/api-client.js";
import { createMcpApp, type McpApp } from "../../mcp/src/transport.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { callTool } from "./helpers/mcp-client.js";

// A real MCP client speaks to a real MCP server, which forwards each caller's
// Bearer credential to a real REST API backed by isolated PostgreSQL. REST stays
// the sole authority for key validity, scope and revocation; this suite proves
// that authority end to end across the protocol boundary.
const jwtSecret = "public-mcp-auth-integration-jwt-secret-32-bytes";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_mcp_auth_test";
const connection = createDatabase(url.href);

const brandId = 94001;
const adId = "mcp-auth-ad-1";
const searchKey = "public-mcp-auth-search-read-key";
const manageKey = "public-mcp-auth-keys-manage-key";
const revocableKey = "public-mcp-auth-revocable-search-key";
const unknownKey = "public-mcp-auth-unknown-but-well-formed-key";

let restServer: Server;
let restOrigin: string;
let mcpApp: McpApp;
let mcpUrl: URL;
let sessionToken: string;
let revocableKeyId: string;

async function insertKey(userId: string, secret: string, scopes: string[]): Promise<string> {
  const [row] = await connection.db
    .insert(apiKeys)
    .values({ userId, keyHash: hashApiKey(secret), prefix: secret.slice(0, 12), scopes })
    .returning({ id: apiKeys.id });
  return row.id;
}

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_mcp_auth_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);

  await connection.db.insert(brands).values({ id: brandId, name: "MCP Auth Brand" });
  await connection.db.insert(ads).values({
    id: adId,
    brandId,
    headline: "Serum launch",
    bodyText: "A real ad fixture for protocol authority checks.",
    niche: "skincare",
    format: "video",
    status: "active",
    startDate: "2026-01-02",
    endDate: null,
    impressionRank: 1,
    countries: ["US"],
    discoveredAt: new Date("2026-01-01Z"),
  });

  const [owner] = await connection.db
    .insert(users)
    .values({ username: "mcp-auth-owner", passwordHash: "unused-rest-fixture-hash" })
    .returning({ id: users.id });
  await insertKey(owner.id, searchKey, ["search:read"]);
  await insertKey(owner.id, manageKey, ["keys:manage"]);
  revocableKeyId = await insertKey(owner.id, revocableKey, ["search:read"]);
  sessionToken = await signToken(owner.id, jwtSecret);

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

describe("a search:read key exercises every tool against real REST", () => {
  it("lists niches", async () => {
    const outcome = await callTool(mcpUrl, bearer(searchKey), "list_niches");
    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    expect((outcome.body as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it("searches ads and sees the seeded fixture", async () => {
    const outcome = await callTool(mcpUrl, bearer(searchKey), "search_ads", { brand_id: brandId });
    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    const ids = (outcome.body as { data: Array<{ id: string }> }).data.map((ad) => ad.id);
    expect(ids).toContain(adId);
  });

  it("gets a single ad by id", async () => {
    const outcome = await callTool(mcpUrl, bearer(searchKey), "get_ad", { id: adId });
    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    expect((outcome.body as { data: { id: string } }).data.id).toBe(adId);
  });
});

describe("REST rejects keys whose authority is insufficient or forged", () => {
  it.each(["list_niches", "search_ads", "get_ad"])(
    "fails %s for a keys:manage-only key with INSUFFICIENT_SCOPE",
    async (tool) => {
      const args = tool === "get_ad" ? { id: adId } : {};
      const outcome = await callTool(mcpUrl, bearer(manageKey), tool, args);
      expect(outcome).toMatchObject({ isError: true, code: "INSUFFICIENT_SCOPE" });
    },
  );

  it("rejects a valid portal session JWT substituted for an API key", async () => {
    const outcome = await callTool(mcpUrl, bearer(sessionToken), "list_niches");
    expect(outcome).toMatchObject({ isError: true, code: "UNAUTHENTICATED" });
  });
});

describe("invalid and missing credentials are classified correctly", () => {
  it("answers an absent credential locally as UNAUTHENTICATED", async () => {
    const outcome = await callTool(mcpUrl, undefined, "list_niches");
    expect(outcome).toMatchObject({ isError: true, code: "UNAUTHENTICATED" });
  });

  it("answers a malformed credential locally as UNAUTHENTICATED", async () => {
    const outcome = await callTool(mcpUrl, "Basic not-a-bearer-key", "list_niches");
    expect(outcome).toMatchObject({ isError: true, code: "UNAUTHENTICATED" });
  });

  it("lets REST classify a well-formed but unknown key as UNAUTHENTICATED", async () => {
    const outcome = await callTool(mcpUrl, bearer(unknownKey), "list_niches");
    expect(outcome).toMatchObject({ isError: true, code: "UNAUTHENTICATED" });
  });
});

describe("revocation through existing API authority blocks the next MCP call", () => {
  it("allows the key, then blocks it once revoked via DELETE /api/v1/keys/:id", async () => {
    const before = await callTool(mcpUrl, bearer(revocableKey), "list_niches");
    expect(before.isError).toBe(false);

    const revoke = await fetch(`${restOrigin}/api/v1/keys/${revocableKeyId}`, {
      method: "DELETE",
      headers: { Authorization: bearer(manageKey) },
    });
    expect(revoke.status).toBe(204);

    // A call whose REST authentication begins after the revocation commit is
    // blocked; already-running calls are given no stronger guarantee.
    const after = await callTool(mcpUrl, bearer(revocableKey), "list_niches");
    expect(after).toMatchObject({ isError: true, code: "UNAUTHENTICATED" });
  });
});
