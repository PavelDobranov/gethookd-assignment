import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createApiClient } from "../src/api-client.js";

const servers: Server[] = [];

async function fixture(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("API HTTP boundary", () => {
  it("makes exactly one unauthenticated GET and preserves valid JSON including extra fields", async () => {
    const requests: string[] = [];
    const body = { data: [{ slug: "skin-care", name: "Skin care", extra: true }], meta: { version: 1 } };
    const baseUrl = await fixture((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      expect(req.headers.authorization).toBeUndefined();
      res.end(JSON.stringify(body));
    });

    const result = await createApiClient({ baseUrl }).listNiches();

    expect(result).toEqual({ isError: false, body });
    expect(requests).toEqual(["GET /api/v1/niches"]);
  });

  it.each([401, 403, 429, 500])("preserves valid upstream error envelopes (%i) without retries", async (status) => {
    let requests = 0;
    const body = {
      error: {
        code: "UPSTREAM_ERROR",
        message: "Request rejected.",
        next_action: "Follow the REST guidance.",
        retryable: status >= 429,
        details: [{ parameter: "quota", reason: "exhausted", allowed_values: [], suggestion: null }],
        extra: "preserved",
      },
    };
    const baseUrl = await fixture((_req, res) => {
      requests++;
      res.writeHead(status).end(JSON.stringify(body));
    });

    expect(await createApiClient({ baseUrl }).listNiches()).toEqual({ isError: true, body });
    expect(requests).toBe(1);
  });

  it.each([
    [200, { data: [{ slug: 5, name: "Invalid" }] }],
    [200, { data: null }],
    [200, { error: { code: "ERROR" } }],
    [500, { data: [] }],
    [500, { error: { code: "ERROR", message: "secret internals" } }],
    [
      500,
      { error: { code: "ERROR", message: "secret internals", next_action: "Wait", retryable: true, details: [{}] } },
    ],
    [200, "<html>secret internals</html>"],
  ])("sanitizes invalid response shapes (%i)", async (status, body) => {
    const baseUrl = await fixture((_req, res) => {
      res.writeHead(status).end(typeof body === "string" ? body : JSON.stringify(body));
    });

    const result = await createApiClient({ baseUrl }).listNiches();

    expect(result.isError).toBe(true);
    expect(result.body).toHaveProperty("error.code", "API_INVALID_RESPONSE");
    expect(JSON.stringify(result)).not.toContain("secret internals");
  });

  it("does not follow redirects or retry the original request", async () => {
    let destinationRequests = 0;
    const destination = await fixture((_req, res) => {
      destinationRequests++;
      res.end(JSON.stringify({ data: [] }));
    });
    let requests = 0;
    const baseUrl = await fixture((_req, res) => {
      requests++;
      res.writeHead(302, { Location: destination }).end();
    });

    const result = await createApiClient({ baseUrl }).listNiches();

    expect(result.isError).toBe(true);
    expect(requests).toBe(1);
    expect(destinationRequests).toBe(0);
    expect(JSON.stringify(result)).not.toContain(destination);
  });

  it.each([false, true])("bounds stalled responses, including body reads (headers sent: %s)", async (sendHeaders) => {
    let requests = 0;
    const baseUrl = await fixture((_req, res) => {
      requests++;
      if (sendHeaders) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"data":');
      }
    });

    const result = await createApiClient({ baseUrl, timeoutMs: 100 }).listNiches();

    expect(result.isError).toBe(true);
    expect(result.body).toHaveProperty("error.code", "API_TIMEOUT");
    expect(requests).toBe(1);
  });

  it("sanitizes connection failures", async () => {
    const baseUrl = await fixture((_req, res) => res.destroy(new Error("secret internals")));
    const result = await createApiClient({ baseUrl }).listNiches();
    expect(result.isError).toBe(true);
    expect(result.body).toHaveProperty("error.code", "API_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain(baseUrl);
    expect(JSON.stringify(result)).not.toContain("secret internals");
  });

  it.each([
    "file:///tmp/api",
    "ftp://example.com",
    "http://user:secret@localhost",
    "http://localhost/api",
    "http://localhost/?key=secret",
    "http://localhost/#fragment",
  ])("rejects invalid API origins without reflecting configuration: %s", (baseUrl) => {
    expect(() => createApiClient({ baseUrl })).toThrow(
      "API base URL must be an HTTP(S) origin without credentials, path, query or fragment.",
    );
  });

  it.each([
    [".", "/api/v1/ads/%2E"],
    ["..", "/api/v1/ads/%2E%2E"],
    ["a/../b", "/api/v1/ads/a%2F..%2Fb"],
  ])("preserves raw detail path segments for %s", async (id, path) => {
    const requests: string[] = [];
    const body = {
      data: {
        id,
        brand_id: 1,
        brand_name: "Brand",
        headline: "Complete headline",
        niche: "skincare",
        format: "video",
        status: "active",
        start_date: "2025-01-01",
        days_active: 10,
        impression_rank: null,
        body_text: "Complete copy",
        end_date: null,
        countries: ["US"],
        discovered_at: "2025-01-02T00:00:00.000Z",
      },
    };
    const baseUrl = await fixture((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.end(JSON.stringify(body));
    });

    expect(await createApiClient({ baseUrl }).getAd({ id })).toEqual({ isError: false, body });
    expect(requests).toEqual([`GET ${path}`]);
  });

  it("sends cursor-only search without inherited-filter defaults and keeps identity in its header", async () => {
    const requests: string[] = [];
    const body = {
      data: [],
      applied_filters: {
        q: "original",
        niche: ["skincare"],
        format: null,
        status: null,
        started_after: null,
        brand_id: 7,
      },
      sort: "impressions",
      limit: 20,
      next_cursor: null,
      cursor_expires_at: "2025-01-01T00:30:00.000Z",
    };
    const baseUrl = await fixture((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      expect(req.headers["idempotency-key"]).toBe("Page:1");
      res.end(JSON.stringify(body));
    });

    expect(
      await createApiClient({ baseUrl }).searchAds({ cursor: "v1.opaque_token-A", idempotency_key: "Page:1" }),
    ).toEqual({ isError: false, body });
    expect(requests).toEqual(["GET /api/v1/ads?cursor=v1.opaque_token-A"]);
  });

  it("omits all unsupplied search fields and generates no billing identity", async () => {
    let path: string | undefined;
    const body = {
      data: [],
      applied_filters: { q: "", niche: [], format: null, status: null, started_after: null, brand_id: null },
      sort: "newest",
      limit: 20,
      next_cursor: null,
      cursor_expires_at: "2025-01-01T00:30:00.000Z",
    };
    const baseUrl = await fixture((req, res) => {
      path = req.url;
      expect(req.headers["idempotency-key"]).toBeUndefined();
      res.end(JSON.stringify(body));
    });
    expect(await createApiClient({ baseUrl }).searchAds({})).toEqual({ isError: false, body });
    expect(path).toBe("/api/v1/ads");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 30_001])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => createApiClient({ baseUrl: "http://localhost:3000", timeoutMs })).toThrow("API timeout");
  });
});
