import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiClient } from "../src/api-client.js";
import { createMcpApp, type McpApp } from "../src/transport.js";

const summary = {
  id: "opaque/ad.id",
  brand_id: 7,
  brand_name: "Example brand",
  headline: `  Complete headline ${"long 🌿 copy ".repeat(2000)}  `,
  niche: "skincare",
  format: "video",
  status: "active",
  start_date: "2025-03-02",
  days_active: -1,
  impression_rank: null,
  extra: { unchanged: true },
};
const response = {
  data: [summary],
  applied_filters: {
    q: "serum",
    niche: ["haircare", "skincare"],
    format: "video",
    status: "active",
    started_after: "2025-03-01",
    brand_id: 7,
    extra: "preserved",
  },
  sort: "impressions",
  limit: 2,
  next_cursor: "v1.Exact_opaque-token.123",
  cursor_expires_at: "2025-04-01T00:30:00.000Z",
  extra: "preserved",
};

const upstreamError = (code: string) => ({
  error: {
    code,
    message: "The supplied search could not be completed.",
    next_action: "Start a fresh search or correct the supplied filters.",
    retryable: false,
    details: [{ parameter: "cursor", reason: code, allowed_values: [], suggestion: null }],
  },
});

describe("search_ads protocol to HTTP boundary", () => {
  let upstream: Server;
  let app: McpApp;
  let client: Client;
  let requests: Array<{ method: string | undefined; path: string; headers: IncomingHttpHeaders }> = [];
  let status = 200;
  let body: unknown = response;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      requests.push({ method: req.method, path: req.url ?? "", headers: req.headers });
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    app = createMcpApp({
      apiClient: createApiClient({ baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }),
    });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    client = new Client({ name: "search-ads-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`),
        { requestInit: { headers: { Authorization: "Bearer key.FORWARD" } } },
      ),
    );
    expect(requests).toEqual([]);
  });

  beforeEach(() => {
    requests = [];
    status = 200;
    body = response;
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
      upstream.closeAllConnections();
    });
  });

  it("discovers all optional inputs with no defaults or upstream preflights", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === "search_ads");
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
      [
        "q",
        "niche",
        "format",
        "status",
        "started_after",
        "brand_id",
        "sort",
        "limit",
        "cursor",
        "idempotency_key",
      ].sort(),
    );
    expect(tool?.inputSchema.required ?? []).toEqual([]);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(tool?.inputSchema)).not.toContain('"default":');
    expect(requests).toEqual([]);
  });

  it("forwards combined filters faithfully, repeats niches and returns unchanged complete JSON", async () => {
    const args = {
      q: "  SeRum %_\\ +&?  ",
      niche: ["skincare", "haircare", "skincare"],
      format: "video",
      status: "active",
      started_after: "2025-03-01",
      brand_id: 7,
      sort: "impressions",
      limit: 2,
      idempotency_key: "Search:1.A_b-9",
    };
    const result = await client.callTool({ name: "search_ads", arguments: args });
    expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(response) }] });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.method).toBe("GET");
    const url = new URL(request.path, "http://fixture");
    expect(url.pathname).toBe("/api/v1/ads");
    expect([...url.searchParams.entries()]).toEqual([
      ["q", args.q],
      ["niche", "skincare"],
      ["niche", "haircare"],
      ["niche", "skincare"],
      ["format", "video"],
      ["status", "active"],
      ["started_after", "2025-03-01"],
      ["brand_id", "7"],
      ["sort", "impressions"],
      ["limit", "2"],
    ]);
    expect(request.headers["idempotency-key"]).toBe(args.idempotency_key);
    expect(request.headers.authorization).toBe("Bearer key.FORWARD");
  });

  it("keeps literal keyword text and valid Unicode code-point bounds unchanged", async () => {
    const q = `  ${"🌿".repeat(500)}  `;
    expect((await client.callTool({ name: "search_ads", arguments: { q } })).isError).toBe(false);
    expect(new URL(requests[0].path, "http://fixture").searchParams.get("q")).toBe(q);
  });

  it.each([{}, { q: "" }, { q: "   " }])(
    "does not inject defaults or identities into a first search: %j",
    async (args) => {
      body = {
        ...response,
        data: [],
        applied_filters: { q: "", niche: [], format: null, status: null, started_after: null, brand_id: null },
        sort: "newest",
        limit: 20,
        next_cursor: null,
      };
      const result = await client.callTool({ name: "search_ads", arguments: args });
      expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });
      expect(requests).toHaveLength(1);
      expect([...new URL(requests[0].path, "http://fixture").searchParams.entries()]).toEqual(Object.entries(args));
      expect(requests[0].headers["idempotency-key"]).toBeUndefined();
    },
  );

  it.each([undefined, 1, 100])("preserves cursor-only continuation with optional changed limit %s", async (limit) => {
    const cursor = response.next_cursor;
    body = { ...response, data: [], limit: limit ?? 20, next_cursor: null };
    const args = limit === undefined ? { cursor } : { cursor, limit };
    const result = await client.callTool({ name: "search_ads", arguments: args });
    expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(requests).toHaveLength(1);
    expect([...new URL(requests[0].path, "http://fixture").searchParams.entries()]).toEqual(
      limit === undefined
        ? [["cursor", cursor]]
        : [
            ["limit", String(limit)],
            ["cursor", cursor],
          ],
    );
  });

  it("walks from a returned cursor to a final page without renewing expiry or resending first-page filters", async () => {
    const first = await client.callTool({
      name: "search_ads",
      arguments: { niche: ["skincare"], brand_id: 7, sort: "impressions", limit: 2 },
    });
    const [block] = first.content as Array<{ type: string; text: string }>;
    const page = JSON.parse(block.text) as typeof response;
    body = { ...response, data: [], limit: 5, next_cursor: null };
    const last = await client.callTool({ name: "search_ads", arguments: { cursor: page.next_cursor, limit: 5 } });
    expect(last).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(requests).toHaveLength(2);
    expect([...new URL(requests[1].path, "http://fixture").searchParams.entries()]).toEqual([
      ["limit", "5"],
      ["cursor", page.next_cursor],
    ]);
    expect(page.cursor_expires_at).toBe(response.cursor_expires_at);
  });

  it("permits impressions with a cursor-inherited brand, leaving integrity and effective brand validation to REST", async () => {
    const result = await client.callTool({
      name: "search_ads",
      arguments: { sort: "impressions", cursor: response.next_cursor },
    });
    expect(result.isError).toBe(false);
    expect([...new URL(requests[0].path, "http://fixture").searchParams.entries()]).toEqual([
      ["sort", "impressions"],
      ["cursor", response.next_cursor],
    ]);
  });

  it("forwards explicitly repeated continuation filters without changing them", async () => {
    const result = await client.callTool({
      name: "search_ads",
      arguments: {
        cursor: response.next_cursor,
        q: "  serum  ",
        niche: ["skincare", "haircare"],
        sort: "impressions",
        brand_id: 7,
      },
    });
    expect(result.isError).toBe(false);
    const parameters = new URL(requests[0].path, "http://fixture").searchParams;
    expect(parameters.get("q")).toBe("  serum  ");
    expect(parameters.getAll("niche")).toEqual(["skincare", "haircare"]);
    expect(parameters.get("cursor")).toBe(response.next_cursor);
  });

  it.each(["0001-01-01", "2024-02-29", "9999-12-31"])(
    "forwards valid exclusive calendar boundary %s without adjustment",
    async (started_after) => {
      expect((await client.callTool({ name: "search_ads", arguments: { started_after } })).isError).toBe(false);
      expect(new URL(requests[0].path, "http://fixture").searchParams.get("started_after")).toBe(started_after);
    },
  );

  it("forwards maximum brand id and a one-character idempotency key", async () => {
    expect(
      (await client.callTool({ name: "search_ads", arguments: { brand_id: 2147483647, idempotency_key: "A" } }))
        .isError,
    ).toBe(false);
    expect(requests[0].path).toBe("/api/v1/ads?brand_id=2147483647");
    expect(requests[0].headers["idempotency-key"]).toBe("A");
  });

  it("does not cache equal searches or generate identities", async () => {
    for (let i = 0; i < 2; i++) {
      expect((await client.callTool({ name: "search_ads", arguments: { q: "serum" } })).isError).toBe(false);
    }
    expect(requests).toHaveLength(2);
    expect(requests.every(({ headers }) => headers["idempotency-key"] === undefined)).toBe(true);
  });

  it.each(["INVALID_CURSOR", "CURSOR_EXPIRED", "CURSOR_QUERY_MISMATCH", "VALIDATION_ERROR"])(
    "preserves REST %s errors without retries",
    async (code) => {
      status = 422;
      body = upstreamError(code);
      const result = await client.callTool({
        name: "search_ads",
        arguments: { cursor: "v1.syntax-valid-but-untrusted", q: "changed" },
      });
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify(body) }] });
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    { niche: [] },
    { niche: ["Skincare"] },
    { niche: ["skincare,haircare"] },
    { niche: "skincare" },
    { q: "x".repeat(501) },
    { q: "🌿".repeat(501) },
    { q: "a\0b" },
    { q: 1 },
    { started_after: "2025-02-29" },
    { started_after: "2025-04-31" },
    { started_after: "0000-01-01" },
    { started_after: "2025-1-01" },
    { started_after: "2025-01-01T00:00:00Z" },
    { format: "gif" },
    { status: "paused" },
    { sort: "best" },
    { sort: "impressions" },
    { brand_id: 0 },
    { brand_id: 2147483648 },
    { brand_id: 1.5 },
    { brand_id: "7" },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "20" },
    { cursor: "" },
    { cursor: "a".repeat(4097) },
    { cursor: "token with spaces" },
    { cursor: "token\n" },
    { idempotency_key: "" },
    { idempotency_key: "a".repeat(129) },
    { idempotency_key: "x\n" },
    { idempotency_key: "has space" },
    { idempotency_key: "é" },
    { niche: null },
    { cursor: null },
    { unknown: true },
    { "niche[]": ["skincare"] },
  ])("rejects invalid/unknown inputs before REST: %j", async (args) => {
    const result = await client.callTool({ name: "search_ads", arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/validation|invalid|unrecognized/i);
    expect(requests).toEqual([]);
  });

  it("explains how to correct an explicit empty niche array", async () => {
    const result = await client.callTool({
      name: "search_ads",
      arguments: { niche: [], cursor: response.next_cursor },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/omit|at least one/i);
    expect(requests).toEqual([]);
  });

  it.each([
    { ...response, data: null },
    { ...response, data: [{ ...summary, headline: null }] },
    { ...response, applied_filters: {} },
    { ...response, next_cursor: 5 },
    { ...response, cursor_expires_at: null },
    { ...response, limit: 0 },
    { ...response, sort: "best" },
  ])("rejects malformed upstream search successes", async (invalidBody) => {
    body = invalidBody;
    const result = await client.callTool({ name: "search_ads", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("INTERNAL_ERROR") }]);
    expect(requests).toHaveLength(1);
  });
});
