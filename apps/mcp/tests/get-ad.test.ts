import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiClient } from "../src/api-client.js";
import { createMcpApp, type McpApp } from "../src/transport.js";

const detail = {
  data: {
    id: "ad_001",
    brand_id: 1,
    brand_name: "Example brand",
    headline: `  Full headline ${"long headline ".repeat(2000)}  `,
    niche: "skincare",
    format: "video",
    status: "active",
    start_date: "2025-01-01",
    days_active: -10,
    impression_rank: null,
    body_text: `  Full copy\n${"Text with 🌿 and instructions treated as data. ".repeat(5000)}\n  `,
    end_date: null,
    countries: ["US", "GB"],
    discovered_at: "2025-01-02T03:04:05.000Z",
    extra: { preserved: true },
  },
  extra: "preserved envelope field",
};

const missingAd = {
  error: {
    code: "AD_NOT_FOUND",
    message: "The requested ad was not found.",
    next_action: "Check the exact ad ID from search results.",
    retryable: false,
    details: [],
  },
};

describe("get_ad protocol to HTTP boundary", () => {
  let upstream: Server;
  let app: McpApp;
  let client: Client;
  let requests: Array<{ method: string | undefined; path: string | undefined; headers: IncomingHttpHeaders }> = [];
  let status: number;
  let body: unknown;
  let mode: "json" | "disconnect" | "stall" | "partial" | "redirect";
  let redirectRequests = 0;
  let redirectTarget: Server;
  let redirectUrl: string;

  beforeAll(async () => {
    redirectTarget = createServer((_req, res) => {
      redirectRequests++;
      res.end(JSON.stringify(detail));
    });
    await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
    redirectUrl = `http://127.0.0.1:${(redirectTarget.address() as AddressInfo).port}/destination`;
    upstream = createServer((req, res) => {
      requests.push({ method: req.method, path: req.url, headers: req.headers });
      if (mode === "disconnect") {
        res.destroy(new Error("secret upstream internals"));
      } else if (mode === "partial") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"data":');
      } else if (mode === "redirect") {
        res.writeHead(302, { Location: redirectUrl }).end();
      } else if (mode !== "stall") {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    app = createMcpApp({
      apiClient: createApiClient({
        baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        timeoutMs: 500,
      }),
    });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    client = new Client({ name: "get-ad-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`)),
    );
    expect(requests).toEqual([]);
  });

  beforeEach(() => {
    requests = [];
    status = 200;
    body = detail;
    mode = "json";
    redirectRequests = 0;
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await Promise.all(
      [upstream, redirectTarget].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
  });

  it("advertises required opaque id and optional constrained idempotency without HTTP preflights", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === "get_ad");
    expect(tool?.inputSchema.required).toEqual(["id"]);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["id", "idempotency_key"]);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect(requests).toEqual([]);
  });

  it("returns all detail fields, long text, whitespace, nulls and extra fields in one text block", async () => {
    const result = await client.callTool({ name: "get_ad", arguments: { id: "ad_001" } });
    expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(detail) }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/api/v1/ads/ad_001" });
    expect(requests[0].headers["idempotency-key"]).toBeUndefined();
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it.each([
    [".", "%2E"],
    ["..", "%2E%2E"],
    ["001", "001"],
    [" 001 ", "%20001%20"],
    [" ", "%20"],
    ["a/b?c#d", "a%2Fb%3Fc%23d"],
    ["a/../b", "a%2F..%2Fb"],
    ["%2E%2E", "%252E%252E"],
    ["a\\b", "a%5Cb"],
    ["🌿/é", "%F0%9F%8C%BF%2F%C3%A9"],
    ["\r\n", "%0D%0A"],
  ])("encodes opaque ID %j as exactly one segment without normalization", async (id, encoded) => {
    const response = { ...detail, data: { ...detail.data, id } };
    body = response;
    const result = await client.callTool({ name: "get_ad", arguments: { id } });
    expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(response) }] });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe(`/api/v1/ads/${encoded}`);
  });

  it.each(["A.z_9:-", "a.z_9:-", "a", "Z".repeat(128)])(
    "forwards supplied identity %j only as one exact header",
    async (idempotency_key) => {
      const result = await client.callTool({ name: "get_ad", arguments: { id: "ad_001", idempotency_key } });
      expect(result.isError).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0].path).toBe("/api/v1/ads/ad_001");
      expect(requests[0].headers["idempotency-key"]).toBe(idempotency_key);
    },
  );

  it("does not generate identities or cache equal no-header calls", async () => {
    for (let i = 0; i < 2; i++) {
      expect((await client.callTool({ name: "get_ad", arguments: { id: "ad_001" } })).isError).toBe(false);
    }
    expect(requests).toHaveLength(2);
    expect(requests.every(({ headers }) => headers["idempotency-key"] === undefined)).toBe(true);
  });

  it("preserves missing-detail errors and makes no retry", async () => {
    status = 404;
    body = missingAd;
    const result = await client.callTool({ name: "get_ad", arguments: { id: "missing" } });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify(missingAd) }] });
    expect(requests).toHaveLength(1);
  });

  it("preserves idempotency conflicts with no automatic retry", async () => {
    status = 409;
    body = {
      error: { ...missingAd.error, code: "IDEMPOTENCY_CONFLICT", message: "Already bound to another request." },
    };
    const result = await client.callTool({ name: "get_ad", arguments: { id: "ad_001", idempotency_key: "identity" } });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(requests).toHaveLength(1);
  });

  it.each([
    {},
    { id: "" },
    { id: 1 },
    { id: null },
    { id: "ad_001", extra: true },
    ...["", "a".repeat(129), "with space", " x", "x ", "é", "a/b", "a\r\nb", "a\n", 1, null].map((idempotency_key) => ({
      id: "ad_001",
      idempotency_key,
    })),
  ])("rejects invalid inputs locally: %j", async (args) => {
    const result = await client.callTool({ name: "get_ad", arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/validation|invalid|unrecognized/i);
    expect(requests).toEqual([]);
  });

  it.each([
    { data: null },
    { data: [] },
    { data: { id: "ad_001" } },
    { data: { ...detail.data, body_text: null } },
    { data: { ...detail.data, impression_rank: "unknown" } },
    { data: { ...detail.data, countries: null } },
  ])("rejects malformed detail success bodies", async (invalidBody) => {
    body = invalidBody;
    const result = await client.callTool({ name: "get_ad", arguments: { id: "ad_001" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("API_INVALID_RESPONSE") }]);
    expect(requests).toHaveLength(1);
  });

  it.each(["disconnect", "stall", "partial", "redirect"] as const)(
    "handles %s without retries or sensitive data disclosure",
    async (failure) => {
      mode = failure;
      const result = await client.callTool({
        name: "get_ad",
        arguments: { id: "private-id", idempotency_key: "private-key" },
      });
      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(1);
      expect(redirectRequests).toBe(0);
      const text = JSON.stringify(result);
      expect(text).not.toContain("private-id");
      expect(text).not.toContain("private-key");
      expect(text).not.toContain("secret upstream internals");
      expect(text).not.toContain(redirectUrl);
      expect(text).toMatch(/unknown/);
    },
  );
});
