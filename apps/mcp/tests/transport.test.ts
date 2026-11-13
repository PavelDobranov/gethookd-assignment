import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiClient } from "../src/api-client.js";
import { createMcpApp, type McpApp } from "../src/transport.js";

/**
 * Raw POST /mcp with caller-controlled Host/Origin so the loopback
 * DNS-rebinding guard can be exercised directly. `fetch` forbids overriding
 * Host, so the low-level http client is used instead. The connection always
 * targets the real loopback port; only the headers vary.
 */
function rawMcpPost(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "guard-probe", version: "0.0.0" },
        },
      }),
    );
  });
}

describe("loopback DNS-rebinding guard", () => {
  let app: McpApp;
  let port: number;

  beforeAll(async () => {
    app = createMcpApp({ apiClient: createApiClient({ baseUrl: "http://127.0.0.1:1" }) });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("rejects a non-localhost Host header with 403 before the handler", async () => {
    const { status } = await rawMcpPost(port, { Host: "evil.example.com" });
    expect(status).toBe(403);
  });

  it("rejects a non-localhost Origin header with 403 before the handler", async () => {
    const { status } = await rawMcpPost(port, {
      Host: `127.0.0.1:${port}`,
      Origin: "http://evil.example.com",
    });
    expect(status).toBe(403);
  });

  it("lets a loopback request through the guard to the handler", async () => {
    const { status } = await rawMcpPost(port, { Host: `127.0.0.1:${port}` });
    // The guard passes a loopback Host through; the handler then answers the
    // initialize exchange itself, so the status is anything but the guard's 403.
    expect(status).not.toBe(403);
  });
});
