import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiClient } from "../src/api-client.js";
import { extractCredential } from "../src/credentials.js";
import { createMcpApp, type McpApp } from "../src/transport.js";

describe("extractCredential", () => {
  it("accepts exactly one Bearer header and forwards it unchanged", () => {
    expect(extractCredential(["Authorization", "Bearer AbC.123_-~+/="])).toEqual({
      ok: true,
      authorization: "Bearer AbC.123_-~+/=",
    });
  });

  it("matches the header name and Bearer scheme case-insensitively", () => {
    expect(extractCredential(["authorization", "bearer tok123"])).toEqual({ ok: true, authorization: "bearer tok123" });
  });

  it("reports an absent credential as missing", () => {
    expect(extractCredential([])).toEqual({ ok: false, reason: "missing" });
    expect(extractCredential(["Content-Type", "application/json"])).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects duplicate Authorization headers as ambiguous", () => {
    expect(extractCredential(["Authorization", "Bearer a1", "authorization", "Bearer b2"])).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("rejects a malformed single header", () => {
    for (const value of ["Basic xyz", "Bearer ", "Bearer tok en", "Bearer ab$cd", "token"]) {
      expect(extractCredential(["Authorization", value])).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

/** A configurable upstream recording each request's relevant headers. */
type Recorded = { method: string; url: string; authorization?: string; idempotency?: string; secret?: string };

function startUpstream(): Promise<{ upstream: Server; baseUrl: string; recorded: Recorded[]; setBody: (b: unknown) => void }> {
  const recorded: Recorded[] = [];
  let body: unknown = { data: [] };
  const upstream = createServer((req, res) => {
    recorded.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
      idempotency: req.headers["idempotency-key"] as string | undefined,
      secret: req.headers["x-secret"] as string | undefined,
    });
    // Echo the caller's credential back through the niche name, so a client can
    // prove end-to-end that its own key reached REST on its own request.
    const payload = Array.isArray((body as { data?: unknown }).data)
      ? { data: [{ slug: "echo", name: req.headers.authorization ?? "" }] }
      : body;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      resolve({ upstream, baseUrl, recorded, setBody: (b) => (body = b) });
    });
  });
}

async function connectClient(url: URL, authorization?: string, extraHeaders: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "auth-test-client", version: "0.0.0" });
  const headers: Record<string, string> = { ...extraHeaders };
  if (authorization !== undefined) headers.Authorization = authorization;
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

describe("credential forwarding over the real protocol", () => {
  let upstream: Server;
  let app: McpApp;
  let url: URL;
  let recorded: Recorded[];

  beforeAll(async () => {
    const up = await startUpstream();
    upstream = up.upstream;
    recorded = up.recorded;
    app = createMcpApp({ apiClient: createApiClient({ baseUrl: up.baseUrl }) });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
      upstream.closeAllConnections();
    });
  });

  beforeEach(() => {
    recorded.length = 0;
  });

  it("answers a tool call with no credential locally, making no REST request", async () => {
    const client = await connectClient(url);
    const result = await client.callTool({ name: "list_niches", arguments: {} });
    await client.close();

    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(block.text).error).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    expect(recorded).toEqual([]);
  });

  it("rejects a malformed credential locally, making no REST request", async () => {
    const client = await connectClient(url, "Basic not-a-bearer-key");
    const result = await client.callTool({ name: "list_niches", arguments: {} });
    await client.close();

    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).error.code).toBe("UNAUTHENTICATED");
    expect(recorded).toEqual([]);
  });

  it("forwards exactly one usable Bearer header unchanged to REST", async () => {
    const client = await connectClient(url, "Bearer key.ABCDEF123");
    const result = await client.callTool({ name: "list_niches", arguments: {} });
    await client.close();

    expect(result.isError).toBe(false);
    expect(recorded).toEqual([{ method: "GET", url: "/api/v1/niches", authorization: "Bearer key.ABCDEF123" }]);
  });

  it("does not forward unrelated inbound headers to REST", async () => {
    const client = await connectClient(url, "Bearer key.XYZ789", { "X-Secret": "leak-me" });
    await client.callTool({ name: "list_niches", arguments: {} });
    await client.close();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].secret).toBeUndefined();
    expect(recorded[0].authorization).toBe("Bearer key.XYZ789");
  });

  it("forwards an optional idempotency identity alongside the credential", async () => {
    const client = await connectClient(url, "Bearer key.IDEMPOT");
    await client.callTool({ name: "get_ad", arguments: { id: "ad_1", idempotency_key: "retry-7" } });
    await client.close();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ authorization: "Bearer key.IDEMPOT", idempotency: "retry-7" });
  });

  it("makes no REST request during initialization and discovery", async () => {
    const client = await connectClient(url, "Bearer key.DISCOVERY");
    await client.listTools();
    await client.close();

    expect(recorded).toEqual([]);
  });

  it("keeps parallel callers' credentials isolated end to end", async () => {
    const [a, b] = await Promise.all([connectClient(url, "Bearer key.AAAAAAAA"), connectClient(url, "Bearer key.BBBBBBBB")]);

    const [resultA, resultB] = await Promise.all([
      a.callTool({ name: "list_niches", arguments: {} }),
      b.callTool({ name: "list_niches", arguments: {} }),
    ]);
    await Promise.all([a.close(), b.close()]);

    const nameOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      JSON.parse((result.content as Array<{ text: string }>)[0].text).data[0].name;
    expect(nameOf(resultA)).toBe("Bearer key.AAAAAAAA");
    expect(nameOf(resultB)).toBe("Bearer key.BBBBBBBB");
    expect(new Set(recorded.map((r) => r.authorization))).toEqual(
      new Set(["Bearer key.AAAAAAAA", "Bearer key.BBBBBBBB"]),
    );
  });
});

describe("loopback Host/Origin protection", () => {
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

  /** Raw POST so forbidden Host/Origin values can be set, which fetch disallows. */
  function rawPost(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.once("error", reject);
      req.end("{}");
    });
  }

  it("rejects a non-loopback Host with 403 even when a credential is present", async () => {
    expect(await rawPost({ Host: "evil.example", Authorization: "Bearer key.ABCDEF" })).toBe(403);
  });

  it("rejects a non-loopback Origin with 403", async () => {
    expect(await rawPost({ Host: "127.0.0.1", Origin: "http://evil.example" })).toBe(403);
  });
});

describe("graceful shutdown", () => {
  it("shuts down cleanly while a credentialed client is still connected", async () => {
    const app = createMcpApp({ apiClient: createApiClient({ baseUrl: "http://127.0.0.1:1" }) });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    const client = await connectClient(url, "Bearer key.SHUTDOWN");

    await app.close();
    expect(app.server.listening).toBe(false);
    await client.close();
  });
});
