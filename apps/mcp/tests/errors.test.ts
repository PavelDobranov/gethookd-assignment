import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/api-client.js";
import { createMcpApp, type McpApp } from "../src/transport.js";

// Exercise the wire rather than letting the SDK client prevalidate tool inputs.
describe.each(["2025-11-25", "2026-07-28"])("tool errors over %s", (version) => {
  let app: McpApp;
  let url: string;
  let upstream: Server;
  let requests = 0;
  let status = 200;
  let body: unknown = { data: [] };
  let listNiches: ReturnType<typeof vi.fn<ReturnType<typeof createApiClient>["listNiches"]>>;

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      requests++;
      res.writeHead(status).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const apiClient = createApiClient({ baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
    listNiches = vi.fn(apiClient.listNiches);
    app = createMcpApp({ apiClient: { ...apiClient, listNiches } });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
  });
  beforeEach(() => {
    requests = 0;
    status = 200;
    body = { data: [] };
    listNiches.mockClear();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
      upstream.closeAllConnections();
    });
  });

  async function send(params: { name: string; arguments?: unknown }) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": version,
        "Mcp-Method": "tools/call",
        "Mcp-Name": params.name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params:
          version === "2026-07-28"
            ? {
                ...(params as object),
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": version,
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              }
            : params,
      }),
    });
    const text = await response.text();
    const json = text.startsWith("event:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
      : text;
    return JSON.parse(json ?? "");
  }

  it.each([
    ["get_ad", {}, "id"],
    ["get_ad", { id: 42 }, "id"],
    ["get_ad", { id: "a", idempotency_key: "bad value" }, "idempotency_key"],
    ["search_ads", { limit: 0 }, "limit"],
    ["search_ads", { niche: [] }, "niche"],
    ["search_ads", { started_after: "2025-02-30" }, "started_after"],
    ["search_ads", { sort: "impressions" }, "brand_id"],
    ["search_ads", { secret_extra: "do-not-echo" }, "secret_extra"],
    ["list_niches", { secret_extra: "do-not-echo" }, "secret_extra"],
    ["missing_tool", {}, "name"],
  ])("returns actionable JSON for %s %j", async (name, args, parameter) => {
    const wire = await send({ name, arguments: args });
    expect(wire.error).toBeUndefined();
    expect(wire.result.isError).toBe(true);
    const body = JSON.parse(wire.result.content[0].text);
    expect(body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      retryable: false,
      next_action: expect.stringMatching(/tools\/list|schema/i),
      details: expect.arrayContaining([expect.objectContaining({ parameter })]),
    });
    expect(body.error.details[0].suggestion).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("do-not-echo");
    expect(listNiches).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it.each([
    ["list_niches", {}],
    ["search_ads", { q: "serum" }],
    ["get_ad", { id: "opaque-ad" }],
  ])("preserves rate wait and quota reset envelopes for %s", async (name, args) => {
    for (const code of ["RATE_LIMITED", "QUOTA_EXCEEDED"]) {
      status = code === "RATE_LIMITED" ? 429 : 403;
      body = {
        error: {
          code,
          message: code === "RATE_LIMITED" ? "Wait 7 seconds." : "Monthly quota exhausted.",
          next_action: code === "RATE_LIMITED" ? "Retry after 7 seconds." : "Wait until 2026-08-01T00:00:00.000Z.",
          retryable: code === "RATE_LIMITED",
          details: [
            {
              parameter: code === "RATE_LIMITED" ? "rate_limit" : "quota",
              reason: "exhausted",
              allowed_values: [],
              suggestion: code === "RATE_LIMITED" ? "7" : "2026-08-01T00:00:00.000Z",
            },
          ],
          extra: { preserved: true },
        },
      };
      const before = requests;
      const wire = await send({ name, arguments: args });
      expect(wire.result).toEqual({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(body) }],
        ...(version === "2026-07-28"
          ? {
              resultType: "complete",
              _meta: { "io.modelcontextprotocol/serverInfo": { name: "gethookd-mcp", version: "0.1.0" } },
            }
          : {}),
      });
      expect(requests - before).toBe(1);
    }
  });

  it("keeps malformed call framing as a protocol failure", async () => {
    const wire = await send({ name: "get_ad", arguments: [] });
    expect(wire.error).toBeDefined();
    expect(wire.result).toBeUndefined();
  });

  it("sanitizes unexpected local exceptions", async () => {
    listNiches.mockRejectedValueOnce(new Error("sensitive-local-data"));
    const wire = await send({ name: "list_niches", arguments: {} });
    expect(wire.result.isError).toBe(true);
    expect(JSON.parse(wire.result.content[0].text).error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(wire)).not.toContain("sensitive-local-data");
    listNiches.mockClear();
  });
});
