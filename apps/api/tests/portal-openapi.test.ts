import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { parse } from "yaml";

import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { apiKeys, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

type Schema = Record<string, unknown>;
type Method = "get" | "post" | "delete";
type ResponseContract = { $ref?: string; content?: { "application/json": { schema: Schema } } };
type Operation = {
  parameters?: { $ref: string }[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<string, ResponseContract>;
};
type Contract = {
  openapi: string;
  security: Record<string, never[]>[];
  paths: Record<string, Record<Method, Operation>>;
  components: {
    securitySchemes: Record<string, Schema>;
    schemas: Record<string, Schema>;
    parameters: Record<string, { name: string; in: string; schema: Schema }>;
    responses: Record<string, ResponseContract>;
  };
};
const contract: Contract = parse(readFileSync(new URL("../../../docs/openapi/portal.yaml", import.meta.url), "utf8"));
const v1: Contract = parse(readFileSync(new URL("../../../docs/openapi/v1.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
// The portal reuses v1 wire shapes, never its API-key authentication boundary.
for (const [name, schema] of Object.entries(v1.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`);
  ajv.addSchema(schema, `v1.yaml#/components/schemas/${name}`);
}
function responseSchema(path: string, method: Method, status: number) {
  const response = contract.paths[path][method].responses[String(status)];
  if (!response) throw new Error(`Undocumented ${method} ${path} status ${status}`);
  const resolved = response.$ref
    ? (response.$ref.startsWith("v1.yaml") ? v1 : contract).components.responses[response.$ref.split("/").at(-1) ?? ""]
    : response;
  const schema = resolved.content?.["application/json"].schema;
  if (!schema) throw new Error(`Missing JSON response schema for ${method} ${path} ${status}`);
  return ajv.compile(schema);
}
const operations = [
  ["/api/portal/keys", "get"],
  ["/api/portal/keys", "post"],
  ["/api/portal/keys/{id}", "delete"],
  ["/api/portal/usage", "get"],
] as const;
const jwtSecret = "portal-openapi-test-jwt-secret";
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_portal_openapi_test";
const connection = createDatabase(url.href);
const { db } = connection;
let server: Server;
let origin: string;
let ownerId: string;
let token: string;
let foreignToken: string;
let apiKeyId: string;
const credential = "public-portal-contract-api-key";

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_portal_openapi_test`);
  } finally {
    await admin.close();
  }
  await migrate(db, { migrationsFolder: "drizzle" });
  server = createApp({ db, jwtSecret }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE api_keys, users CASCADE`);
  const [owner, foreign] = await db
    .insert(users)
    .values([
      { username: "owner", passwordHash: "unused" },
      { username: "foreign", passwordHash: "unused" },
    ])
    .returning();
  ownerId = owner.id;
  token = await signToken(owner.id, jwtSecret);
  foreignToken = await signToken(foreign.id, jwtSecret);
  const [key] = await db
    .insert(apiKeys)
    .values(apiKeyFixture(ownerId, hashApiKey(credential), credential.slice(0, 12)))
    .returning();
  apiKeyId = key.id;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

async function request(
  path: string,
  method: Method = "get",
  status = 200,
  body?: string,
  bearer: string | null = token,
  headers = {},
) {
  const operation = path.split("?")[0].startsWith("/keys/")
    ? "/api/portal/keys/{id}"
    : `/api/portal${path.split("?")[0]}`;
  const response = await fetch(`${origin}/api/portal${path}`, {
    method: method.toUpperCase(),
    headers: {
      ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
      "Content-Type": "application/json",
      "Idempotency-Key": "ignored invalid value!",
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  if (status === 204) {
    expect(contract.paths[operation][method].responses["204"]).toBeDefined();
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
    return null;
  }
  expect(response.headers.get("content-type")).toContain("application/json");
  const result: unknown = await response.json();
  const accepts = responseSchema(operation, method, status);
  expect(accepts(result), JSON.stringify(accepts.errors)).toBe(true);
  if (status >= 400) expect(result).toMatchObject({ error: { retryable: status === 500 } });
  if (status === 422) expect(result).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  return result;
}
type Metadata = {
  id: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};
type Created = { data: Metadata; secret: string };
type List = { data: Metadata[]; limit: number; offset: number; has_more: boolean };
type Usage = {
  data: { period_start: string; period_end: string; billable_calls: number; quota: number; remaining: number };
};
function create(scopes = ["search:read"]) {
  return request("/keys", "post", 201, JSON.stringify({ scopes })) as Promise<Created>;
}

it("validates all success contracts, reveal-once allowlists, nullable dates, pagination and revoke emptiness", async () => {
  const created: Created[] = [];
  for (const scopes of [["search:read"], ["keys:manage"], ["keys:manage", "search:read"]]) {
    const schema = contract.paths["/api/portal/keys"].post.requestBody?.content["application/json"].schema;
    if (!schema) throw new Error("Missing portal creation input schema");
    expect(ajv.compile(schema)({ scopes })).toBe(true);
    const result = await create(scopes);
    expect(result.data).toMatchObject({
      prefix: result.secret.slice(0, 12),
      last_used_at: null,
      revoked_at: null,
      scopes: scopes.length === 2 ? ["search:read", "keys:manage"] : scopes,
    });
    created.push(result);
  }
  expect(new Set(created.map(({ secret }) => secret)).size).toBe(3);
  // Make tie-order deterministic instead of relying on insertion timing.
  await db.update(apiKeys).set({ createdAt: new Date("2026-01-01T00:00:00Z") });
  const all = (await request("/keys")) as List;
  expect(all).toMatchObject({ limit: 20, offset: 0, has_more: false });
  expect(all.data).toHaveLength(4);
  expect(all.data.map(({ id }) => id)).toEqual(all.data.map(({ id }) => id).sort());
  for (const { secret } of created) {
    expect(JSON.stringify(all)).not.toContain(secret);
    expect(JSON.stringify(all)).not.toContain(hashApiKey(secret));
  }
  expect(await request("/keys?limit=02&offset=00")).toEqual({
    data: all.data.slice(0, 2),
    limit: 2,
    offset: 0,
    has_more: true,
  });
  expect(await request("/keys?limit=2&offset=2")).toEqual({
    data: all.data.slice(2),
    limit: 2,
    offset: 2,
    has_more: false,
  });
  expect(await request("/keys?limit=100&offset=99")).toEqual({ data: [], limit: 100, offset: 99, has_more: false });
  await request(`/keys/${created[0].data.id}`, "delete", 204);
  const revoked = (await request("/keys")) as List;
  expect(revoked.data.find(({ id }) => id === created[0].data.id)?.revoked_at).toEqual(expect.any(String));
  await request(`/keys/${created[0].data.id}`, "delete", 204);
  expect(await request("/keys")).toEqual(revoked);
  expect(((await request("/usage")) as Usage).data).toMatchObject({ billable_calls: 0, quota: 1000, remaining: 1000 });
});

it("reads the exact settled owner meter, non-null last-used dates, and remains outside key rate admission", async () => {
  const response = await fetch(`${origin}/api/v1/ads?q=absent`, { headers: { Authorization: `Bearer ${credential}` } });
  expect(response.status).toBe(200);
  await response.json();
  const usage = (await request("/usage")) as Usage;
  expect(usage.data).toMatchObject({ billable_calls: 1, quota: 1000, remaining: 999 });
  expect(usage.data.period_start).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  expect(usage.data.period_end).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  const start = new Date(usage.data.period_start);
  expect(usage.data.period_end).toBe(
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString(),
  );
  expect(((await request("/keys")) as List).data[0].last_used_at).toEqual(expect.any(String));
  await db.execute(
    sql`UPDATE api_keys SET rate_admissions = array_fill(clock_timestamp(), ARRAY[60]) WHERE id = ${apiKeyId}::uuid`,
  );
  expect(await request("/usage")).toEqual(usage);
  await request("/keys");
  const made = await create();
  await request(`/keys/${made.data.id}`, "delete", 204);
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId));
  expect(key.rateAdmissions).toHaveLength(60);
  expect(await request("/usage")).toEqual(usage);
});

it.each(operations)(
  "validates JWT-only 401, input 422, route 404 and server 500 for %s %s",
  async (operation, method) => {
    const path = operation.replace("/api/portal", "").replace("{id}", "00000000-0000-0000-0000-000000000000");
    const body = method === "post" ? '{"scopes":["search:read"]}' : undefined;
    for (const bearer of [null, "invalid", credential, await signToken(ownerId, "wrong-secret")]) {
      expect(await request(path, method, 401, body, bearer)).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    }
    await request(`${path}?unknown=x`, method, 422, body);
    // Exercise real unsupported-method HTTP, checking against this operation's documented 404.
    const response = await fetch(`${origin}/api/portal${path}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const notFound: unknown = await response.json();
    expect(responseSchema(operation, method, 404)(notFound)).toBe(true);
    expect(notFound).toMatchObject({ error: { code: "NOT_FOUND" } });
    const spy = vi.spyOn(db.$client, "query").mockRejectedValueOnce(new Error("private portal SQL sentinel"));
    try {
      const error = await request(path, method, 500, body);
      expect(error).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
      expect(JSON.stringify(error)).not.toContain("private portal SQL sentinel");
    } finally {
      spy.mockRestore();
    }
  },
);

it.each([
  "null",
  "[]",
  "1",
  '"text"',
  "{}",
  '{"scopes":[]}',
  '{"scopes":"search:read"}',
  '{"scopes":[null]}',
  '{"scopes":["unknown"]}',
  '{"scopes":["search:read","search:read"]}',
  '{"scopes":["search:read"],"owner_id":"foreign"}',
])("agrees on rejected JSON body %s", async (body) => {
  const schema = contract.paths["/api/portal/keys"].post.requestBody?.content["application/json"].schema;
  if (!schema) throw new Error("Missing portal creation input schema");
  expect(ajv.compile(schema)(JSON.parse(body))).toBe(false);
  await request("/keys", "post", 422, body);
});

it("validates malformed JSON 400, unsupported content and the local 16 KB 413 boundary", async () => {
  expect(await request("/keys", "post", 400, "{")).toMatchObject({ error: { code: "MALFORMED_JSON" } });
  expect(await request("/keys", "post", 413, JSON.stringify({ scopes: ["x".repeat(17000)] }))).toMatchObject({
    error: { code: "BODY_TOO_LARGE" },
  });
  await request("/keys", "post", 422, "{}", token, { "Content-Type": "text/plain" });
  await request("/keys", "post", 400, "{}", token, { "Content-Type": "application/json; charset=invalid" });
});

it.each([
  "limit=0",
  "limit=101",
  "limit=-1",
  "limit=1.5",
  "limit=1e1",
  "limit=",
  "limit=1&limit=2",
  "offset=-1",
  "offset=9007199254740992",
  "offset=1.1",
  "offset=%2B1",
  "offset=",
  "offset=1&offset=2",
  "offset[x]=1",
  "owner_id=other",
  "api_key=secret",
  "limit=2&extra=x",
])("rejects strict metadata query %s", async (query) => {
  await request(`/keys?${query}`, "get", 422);
});

it("pins parameter allowlists and missing/foreign UUID privacy without leaking owner metadata", async () => {
  expect(contract.paths["/api/portal/keys"].get.parameters).toEqual([
    { $ref: "v1.yaml#/components/parameters/KeyLimit" },
    { $ref: "v1.yaml#/components/parameters/KeyOffset" },
  ]);
  for (const [name, valid, invalid] of [
    ["KeyLimit", [1, 100], [0, 101, 1.5]],
    ["KeyOffset", [0, 9007199254740991], [-1, 9007199254740992, 1.5]],
    ["KeyId", [apiKeyId], ["not-a-uuid"]],
  ] as const) {
    const accepts = ajv.compile(v1.components.parameters[name].schema);
    for (const value of valid) expect(accepts(value)).toBe(true);
    for (const value of invalid) expect(accepts(value)).toBe(false);
  }
  for (const id of ["not-a-uuid", "%ZZ"]) await request(`/keys/${id}`, "delete", 422);
  const made = await create();
  const denied = await request(`/keys/${made.data.id}`, "delete", 404, undefined, foreignToken);
  expect(denied).toMatchObject({ error: { code: "KEY_NOT_FOUND" } });
  expect(await request("/keys/00000000-0000-0000-0000-000000000000", "delete", 404)).toEqual(denied);
  expect(await request("/keys", "get", 200, undefined, foreignToken)).toEqual({
    data: [],
    limit: 20,
    offset: 0,
    has_more: false,
  });
  expect(((await request("/usage", "get", 200, undefined, foreignToken)) as Usage).data.billable_calls).toBe(0);
});

it("detects response allowlist, required-field, date and nullable-schema drift against real HTTP bodies", async () => {
  const actual = await create();
  const accepts = responseSchema("/api/portal/keys", "post", 201);
  for (const change of [
    { secret: actual.secret },
    { key_hash: "private" },
    { user_id: ownerId },
    { created_at: null },
    { last_used_at: "invalid" },
    { revoked_at: "2026-02-30T00:00:00Z" },
    { scopes: [] },
    { scopes: ["keys:manage", "search:read"] },
  ]) {
    expect(accepts({ ...actual, data: { ...actual.data, ...change } })).toBe(false);
  }
  expect(accepts({ ...actual, extra: true })).toBe(false);
  const missing: Record<string, unknown> = { ...actual.data };
  delete missing.revoked_at;
  expect(accepts({ ...actual, data: missing })).toBe(false);
  const usage = (await request("/usage")) as Usage;
  expect(responseSchema("/api/portal/usage", "get", 200)({ data: { ...usage.data, remaining: null } })).toBe(false);
  expect(responseSchema("/api/portal/usage", "get", 200)({ data: { ...usage.data, per_key: [] } })).toBe(false);
});

it("compiles every documented response and keeps JWT security separate from API-key security", () => {
  expect(contract.openapi).toMatch(/^3\.1\./);
  expect(Object.keys(contract.paths)).toEqual(["/api/portal/keys", "/api/portal/keys/{id}", "/api/portal/usage"]);
  expect(contract.security).toEqual([{ BearerPortalJwt: [] }]);
  expect(contract.components.securitySchemes).toEqual({
    BearerPortalJwt: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  });
  for (const [path, method] of operations) {
    for (const status of Object.keys(contract.paths[path][method].responses)) {
      expect(status).not.toBe("429");
      if (status !== "204") expect(responseSchema(path, method, Number(status))).toBeTypeOf("function");
    }
  }
});
