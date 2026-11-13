import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/api-client.js";
import { createMcpApp, type McpApp } from "../src/transport.js";

// Exercise the wire rather than letting the SDK client prevalidate tool inputs.
describe.each(["2025-11-25", "2026-07-28"])("tool errors over %s", (version) => {
  let app: McpApp;
  let url: string;
  const listNiches = vi.fn(async () => ({ isError: false as const, body: { data: [] } }));

  beforeAll(async () => {
    app = createMcpApp({ apiClient: { ...createApiClient({ baseUrl: "http://127.0.0.1:1" }), listNiches } });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(async () => app.close());

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
