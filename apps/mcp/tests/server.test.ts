import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "../src/api-client.js";
import { createMcpServer } from "../src/server.js";
import { createMcpApp, type McpApp } from "../src/transport.js";

const expectedTools = ["search_ads", "get_ad", "list_niches"] as const;

/** Starts the app on an ephemeral loopback port and returns its /mcp URL. */
async function startApp(
  apiClient = createApiClient({ baseUrl: "http://127.0.0.1:1" }),
): Promise<{ app: McpApp; url: URL }> {
  const app = createMcpApp({ apiClient });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  return { app, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

describe("MCP server", () => {
  let app: McpApp;
  let client: Client;

  beforeAll(async () => {
    const started = await startApp();
    app = started.app;
    client = new Client({ name: "mcp-test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(started.url));
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  it("initializes a server instance", () => {
    expect(createMcpServer(createApiClient({ baseUrl: "http://127.0.0.1:1" }))).toBeDefined();
  });

  it("exposes exactly the three expected tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...expectedTools].sort());
  });

  it("describes search_ads with its filters and cross-tool guidance", async () => {
    const { tools } = await client.listTools();
    const searchAds = tools.find((tool) => tool.name === "search_ads");

    expect(searchAds?.description).toBeTruthy();
    const description = searchAds?.description ?? "";
    expect(description).toContain("list_niches");
    expect(description).toContain("get_ad");
    expect(description).toContain("brand_id");
    expect(description).toContain("cursor");

    const properties = (searchAds?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(
      [
        "brand_id",
        "cursor",
        "format",
        "idempotency_key",
        "limit",
        "niche",
        "q",
        "sort",
        "started_after",
        "status",
      ].sort(),
    );
  });

  it("requires an opaque string id for get_ad", async () => {
    const { tools } = await client.listTools();
    const getAd = tools.find((tool) => tool.name === "get_ad");

    expect(getAd?.description).toBeTruthy();
    const properties = (getAd?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["id", "idempotency_key"]);
    expect(getAd?.inputSchema.required).toContain("id");
  });

  it("registers list_niches with no inputs", async () => {
    const { tools } = await client.listTools();
    const listNiches = tools.find((tool) => tool.name === "list_niches");

    expect(listNiches?.description).toBeTruthy();
    const properties = (listNiches?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties)).toHaveLength(0);
  });

  it("returns a safe tool error when REST cannot be reached", async () => {
    const calls = [client.callTool({ name: "search_ads", arguments: { q: "serum", niche: ["skincare"] } })];

    for (const call of calls) {
      const result = await call;
      expect(result.isError).toBe(true);
      const [block] = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(block.text).error).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
    }
  });

  it("rejects invalid tool arguments before reaching the handler", async () => {
    const result = await client.callTool({ name: "search_ads", arguments: { limit: 0 } });

    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(block.text).error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: [expect.objectContaining({ parameter: "limit" })],
    });
  });

  it("rejects a missing required argument for get_ad", async () => {
    const result = await client.callTool({ name: "get_ad", arguments: {} });

    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(block.text).error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: [expect.objectContaining({ parameter: "id" })],
    });
  });
});

describe("list_niches HTTP integration", () => {
  let upstream: Server;
  let app: McpApp;
  let client: Client;
  let requests: string[] = [];
  let status = 200;
  let body: unknown;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const started = await startApp(createApiClient({ baseUrl }));
    app = started.app;
    client = new Client({ name: "http-boundary-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(started.url));
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
      upstream.closeAllConnections();
    });
  });

  it("discovers without HTTP preflights and invokes exactly one GET with unchanged JSON", async () => {
    await client.listTools();
    expect(requests).toEqual([]);
    body = { data: [{ slug: "skin-care", name: "Skin care", extra: "unchanged" }], meta: { total: 1 } };

    const result = await client.callTool({ name: "list_niches", arguments: {} });

    expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(requests).toEqual(["GET /api/v1/niches"]);
  });

  it("returns an empty niche list as a genuine success", async () => {
    requests = [];
    body = { data: [] };
    const result = await client.callTool({ name: "list_niches", arguments: {} });
    expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(requests).toHaveLength(1);
  });

  it("returns the REST authentication envelope as a tool error, not an empty success", async () => {
    requests = [];
    status = 401;
    body = {
      error: {
        code: "UNAUTHENTICATED",
        message: "A valid Bearer API key is required.",
        next_action: "Provide a stored API key in Authorization: Bearer <key>.",
        retryable: false,
        details: [],
      },
    };

    const result = await client.callTool({ name: "list_niches", arguments: {} });

    expect(result).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(requests).toHaveLength(1);
  });

  it("returns sanitized invalid-response errors through the real protocol", async () => {
    requests = [];
    status = 200;
    body = { data: "secret internals" };
    const result = await client.callTool({ name: "list_niches", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("INTERNAL_ERROR") }]);
    expect(JSON.stringify(result)).not.toContain("secret internals");
    expect(requests).toHaveLength(1);
  });
});

describe("MCP HTTP server lifecycle", () => {
  it("starts and shuts down cleanly", async () => {
    const { app } = await startApp();
    expect(app.server.listening).toBe(true);

    await app.close();
    expect(app.server.listening).toBe(false);
  });

  it("shuts down even while a client is still connected", async () => {
    const { app, url } = await startApp();
    const client = new Client({ name: "lingering-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));

    // Deliberately do not close the client first: an open connection must not
    // block graceful shutdown.
    await app.close();
    expect(app.server.listening).toBe(false);
    await client.close();
  });
});
