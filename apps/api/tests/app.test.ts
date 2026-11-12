import { once } from "node:events";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";

// Unavailable health and unknown routes remain testable without PostgreSQL.
const database = createDatabase("postgresql://test:test@127.0.0.1:1/test");
afterAll(database.close);

let app: ReturnType<typeof createApp>;
let server: Server | undefined;
let baseUrl: string;

beforeEach(async () => {
  app = createApp({
    db: database.db,
    jwtSecret: "app-test-only-signing-secret-at-least-32-bytes",
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) {
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

describe("API over HTTP", () => {
  it("reports unavailable health rather than process existence", async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." },
    });
  });

  it("does not apply auth JSON parsing or cache policy to other routes", async () => {
    app.post("/api/echo", (req, res) => res.json({ bodyParsed: req.body !== undefined }));
    const response = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "42",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bodyParsed: false });
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("keeps auth parser errors uncached and in the existing error format", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid JSON request." },
    });
  });

  it("returns an API 404 rather than the SPA for an unknown API route", async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Cannot GET /api/does-not-exist");
  });
});
