import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { parse } from "yaml";

import { niches } from "../src/ads/model.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { createDatabase } from "../src/db/client.js";
import { initializeDatabase } from "../src/db/initialize.js";
import { ads, apiKeys, brands, users } from "../src/db/schema.js";
import { apiKeyFixture } from "./api-key-fixtures.js";

type Schema = Record<string, unknown>;
type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  style?: string;
  explode?: boolean;
  schema: Schema;
};
type Method = "get" | "post" | "delete";
type ParameterReference = Parameter | { $ref: string };
type Operation = {
  parameters?: ParameterReference[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<string, { $ref?: string; content?: { "application/json": { schema: Schema } } }>;
};
type Contract = {
  openapi: string;
  security: { BearerApiKey: never[] }[];
  paths: Record<string, Record<Method, Operation>>;
  components: {
    parameters: Record<string, Parameter>;
    schemas: Record<string, Schema>;
    responses: Record<
      string,
      {
        headers?: Record<string, { schema: Schema }>;
        content: { "application/json": { schema: Schema } };
      }
    >;
    securitySchemes: Record<string, Schema>;
  };
};

const contract: Contract = parse(readFileSync(new URL("../../../docs/openapi/v1.yaml", import.meta.url), "utf8"));

// Ajv resolves schema references; only OpenAPI's response-object reference needs unwrapping.
function validators(document: Contract) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }
  return {
    response(path: string, status: number, method: Method = "get") {
      const response = document.paths[path][method].responses[String(status)];
      if (!response) throw new Error(`Undocumented ${method.toUpperCase()} ${path} status ${status}`);
      const resolved = response.$ref
        ? document.components.responses[response.$ref.replace("#/components/responses/", "")]
        : response;
      const schema = resolved.content?.["application/json"].schema;
      if (!schema) throw new Error(`Missing JSON schema for ${method.toUpperCase()} ${path} status ${status}`);
      return ajv.compile(schema);
    },
    parameter(parameter: Parameter) {
      return ajv.compile(parameter.schema);
    },
  };
}

const validate = validators(contract);
const paths = ["/api/v1/ads", "/api/v1/ads/{id}", "/api/v1/niches"];
const management = [
  ["/api/v1/keys", "get"],
  ["/api/v1/keys", "post"],
  ["/api/v1/keys/{id}", "delete"],
  ["/api/v1/usage", "get"],
] as const;
const jwtSecret = "public-v1-openapi-jwt-secret-32-bytes";

function queryParameters() {
  return (contract.paths["/api/v1/ads"].get.parameters ?? [])
    .map((parameter) =>
      "$ref" in parameter
        ? contract.components.parameters[parameter.$ref.replace("#/components/parameters/", "")]
        : parameter,
    )
    .filter((parameter) => parameter.in === "query");
}
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_openapi_test";
const connection = createDatabase(url.href);
let key: string;
let ownerId: string;
let keyId: string;
let caseNumber = 0;
const brandId = 94001;
let server: Server;
let origin: string;

beforeAll(async () => {
  const admin = createDatabase(inject("postgresUrl"));
  try {
    await admin.db.execute(sql`CREATE DATABASE gethookd_v1_openapi_test`);
  } finally {
    await admin.close();
  }
  await initializeDatabase(url.href);
  await connection.db.delete(ads);
  await connection.db.insert(brands).values([
    { id: brandId, name: "Contract Brand" },
    { id: brandId + 1, name: "Other Brand" },
  ]);
  const base = {
    brandId,
    headline: "SERUM 50%_\\ off",
    bodyText: "Ordinary body",
    niche: "skincare" as const,
    format: "video" as const,
    status: "active" as const,
    startDate: "2026-01-02",
    endDate: null,
    impressionRank: null,
    countries: ["US"],
    discoveredAt: new Date("2026-01-01T00:00:00Z"),
  };
  await connection.db.insert(ads).values([
    { ...base, id: "A", impressionRank: 1 },
    { ...base, id: "B", headline: "Other", bodyText: "Try sErUm", impressionRank: 3 },
    { ...base, id: "C", niche: "haircare", format: "image", startDate: "2026-01-01" },
    { ...base, id: "D", status: "inactive", endDate: "2026-01-04", startDate: "2026-01-01" },
    { ...base, id: "opaque /é", brandId: brandId + 1, niche: "fitness", headline: "Unrelated" },
  ]);
  server = createApp({ db: connection.db, jwtSecret }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});

// Fresh identities isolate allowance/quota state; each contract case keeps its key.
beforeEach(async () => {
  key = `public-v1-openapi-test-key-${++caseNumber}`;
  const [owner] = await connection.db
    .insert(users)
    .values({
      username: key,
      passwordHash: "unused-rest-fixture-hash",
    })
    .returning({ id: users.id });
  ownerId = owner.id;
  const [created] = await connection.db
    .insert(apiKeys)
    .values(apiKeyFixture(owner.id, hashApiKey(key), key.slice(0, 12)))
    .returning({ id: apiKeys.id });
  keyId = created.id;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

async function request(
  path: string,
  operation: string,
  status = 200,
  authorization: string | null = `Bearer ${key}`,
  options: RequestInit = {},
  method: Method = "get",
) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    method: method.toUpperCase(),
    headers: { ...(authorization === null ? {} : { Authorization: authorization }), ...options.headers },
  });
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  if (status === 204) {
    expect(contract.paths[operation][method].responses["204"]).toBeDefined();
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
    return null;
  }
  if (status === 429) {
    const wait = response.headers.get("retry-after");
    expect(wait).toMatch(/^[1-9][0-9]*$/);
    const header = contract.components.responses.RateLimited.headers?.["Retry-After"];
    if (!header) throw new Error("Missing Retry-After schema");
    expect(validate.parameter({ name: "Retry-After", in: "header", schema: header.schema })(Number(wait))).toBe(true);
  }
  expect(response.headers.get("content-type")).toContain("application/json");
  const body: unknown = await response.json();
  const accepts = validate.response(operation, response.status, method);
  expect(accepts(body), JSON.stringify(accepts.errors)).toBe(true);
  if (status === 429) {
    const error = body as { error: { message: string; next_action: string } };
    const wait = response.headers.get("retry-after");
    expect(error.error.message).toContain(`${wait} seconds`);
    expect(error.error.next_action).toContain(`${wait} seconds`);
  }
  return body;
}

type SearchBody = {
  data: { id: string; impression_rank: number | null }[];
  applied_filters: Record<string, unknown>;
  sort: string;
  limit: number;
  next_cursor: string | null;
  cursor_expires_at: string;
};
async function search(query = "") {
  return (await request(`/api/v1/ads?${query}`, "/api/v1/ads")) as SearchBody;
}

it("validates actual populated search, nullable detail and catalog HTTP responses", async () => {
  expect((await search()).data).toHaveLength(5);
  expect(await request("/api/v1/ads/A", "/api/v1/ads/{id}")).toMatchObject({
    data: { end_date: null, impression_rank: 1, countries: ["US"], discovered_at: "2026-01-01T00:00:00.000Z" },
  });
  expect(await request("/api/v1/ads/D", "/api/v1/ads/{id}")).toMatchObject({
    data: { end_date: "2026-01-04", impression_rank: null },
  });
  await request(`/api/v1/ads/${encodeURIComponent("opaque /é")}`, "/api/v1/ads/{id}");
  const catalog = await request("/api/v1/niches", "/api/v1/niches", 200, `Bearer ${key}`, {
    headers: { "Idempotency-Key": "ignored invalid value!" },
  });
  expect(catalog).toEqual({ data: niches.map(({ slug, name }) => ({ slug, name })) });
  expect(contract.components.schemas.NicheSlug.enum).toEqual(niches.map(({ slug }) => slug));
});

it.each([
  ["q=serum", ["A", "B", "C", "D"]],
  ["q=50%25_%5C", ["A", "C", "D"]],
  ["niche=haircare", ["C"]],
  ["niche=haircare&niche=fitness", ["opaque /é", "C"]],
  ["format=image", ["C"]],
  ["status=inactive", ["D"]],
  ["started_after=2026-01-01", ["A", "B", "opaque /é"]],
  [`brand_id=${brandId + 1}`, ["opaque /é"]],
  [`q=serum&niche=skincare&format=video&status=active&started_after=2026-01-01&brand_id=${brandId}`, ["A", "B"]],
])("checks filter %s against positive AND negative fixtures", async (query, ids) => {
  expect((await search(query)).data.map(({ id }) => id)).toEqual(ids);
});

it("validates empty/default echoes and both sorts through final/null cursors", async () => {
  const parameters = queryParameters();
  const defaults = Object.fromEntries(parameters.map(({ name, schema }) => [name, schema.default]));
  const empty = await search("brand_id=2147483647");
  expect(empty).toMatchObject({
    data: [],
    next_cursor: null,
    sort: contract.components.schemas.Sort.default,
    limit: defaults.limit,
    applied_filters: {
      q: defaults.q,
      niche: defaults.niche,
      format: null,
      status: null,
      started_after: null,
      brand_id: 2147483647,
    },
  });
  for (const sort of ["newest", "impressions"]) {
    const first = await search(`q=%20SERUM%20&niche=skincare&niche=skincare&brand_id=0${brandId}&sort=${sort}&limit=1`);
    expect(first.applied_filters).toEqual({
      q: "SERUM",
      niche: ["skincare"],
      format: null,
      status: null,
      started_after: null,
      brand_id: brandId,
    });
    expect(first.next_cursor).toBeTypeOf("string");
    const last = await search(`cursor=${first.next_cursor}&limit=100`);
    expect(last.applied_filters).toEqual(first.applied_filters);
    expect(last.sort).toBe(sort);
    expect(last.limit).toBe(100);
    expect(last.cursor_expires_at).toBe(first.cursor_expires_at);
    expect(last.next_cursor).toBeNull();
    expect([...first.data, ...last.data].map(({ id }) => id)).toEqual(["A", "B", "D"]);
    expect(last.data.at(-1)?.impression_rank).toBeNull();
  }
});

async function expectError(path: string, operation: string, status: number, code: string, auth?: string | null) {
  const body = await request(path, operation, status, auth);
  expect(body).toMatchObject({ error: { code, retryable: status === 500 } });
  return body;
}

it.each(paths)("validates 401 and injected database 500 for GET %s", async (operation) => {
  const path = operation.replace("{id}", "A");
  for (const auth of [null, "Basic invalid", "Bearer invalid", "Bearer portal.jwt.token"]) {
    await expectError(path, operation, 401, "UNAUTHENTICATED", auth);
  }
  const spy = vi.spyOn(connection.db.$client, "connect").mockRejectedValueOnce(new Error("private SQL sentinel"));
  try {
    expect(JSON.stringify(await expectError(path, operation, 500, "INTERNAL_ERROR"))).not.toContain(
      "private SQL sentinel",
    );
  } finally {
    spy.mockRestore();
  }
});

it("validates missing-route/ad 404 and resource/path validation 422 over HTTP", async () => {
  await expectError("/api/v1/unknown", "/api/v1/ads", 404, "NOT_FOUND");
  await expectError("/api/v1/ads/missing", "/api/v1/ads/{id}", 404, "AD_NOT_FOUND");
  await expectError("/api/v1/ads/%ZZ", "/api/v1/ads/{id}", 422, "VALIDATION_ERROR");
  for (const [path, operation] of [
    ["/api/v1/niches?limit=1", "/api/v1/niches"],
    ["/api/v1/ads/A?q=x", "/api/v1/ads/{id}"],
  ]) {
    await expectError(path, operation, 422, "VALIDATION_ERROR");
  }
});

it.each<[string, string, unknown, boolean]>([
  ["q", "  Serum  ", "Serum", true],
  ["q", "   ", "", true],
  ["q", "🦊".repeat(500), "🦊".repeat(500), true],
  ["q", "x".repeat(501), "x".repeat(501), false],
  ["q", "\u0000", "\u0000", false],
  ["niche", "skincare", ["skincare"], true],
  ["niche", "Skincare", ["Skincare"], false],
  ["niche", "Pet Supplies", ["Pet Supplies"], false],
  ["niche", "skincare,haircare", ["skincare,haircare"], false],
  ["niche", "", [""], false],
  ["format", "carousel", "carousel", true],
  ["format", "Video", "Video", false],
  ["format", "", "", false],
  ["status", "active", "active", true],
  ["status", "Active", "Active", false],
  ["status", "", "", false],
  ["started_after", "2024-02-29", "2024-02-29", true],
  ["started_after", "0001-01-01", "0001-01-01", true],
  ["started_after", "9999-12-31", "9999-12-31", true],
  ["started_after", "0000-01-01", "0000-01-01", false],
  ["started_after", "2026-02-30", "2026-02-30", false],
  ["started_after", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", false],
  ["brand_id", "0001", 1, true],
  ["brand_id", "2147483647", 2147483647, true],
  ["brand_id", "2147483648", 2147483648, false],
  ["brand_id", "0", 0, false],
  ["brand_id", "+1", "+1", false],
  ["brand_id", " 1", " 1", false],
  ["brand_id", "1.0", "1.0", false],
  ["brand_id", "1e1", "1e1", false],
  ["sort", "newest", "newest", true],
  ["sort", "Newest", "Newest", false],
  ["sort", "", "", false],
  ["limit", "01", 1, true],
  ["limit", "100", 100, true],
  ["limit", "0", 0, false],
  ["limit", "101", 101, false],
  ["limit", "", "", false],
  ["limit", "1.5", "1.5", false],
  ["cursor", "", "", false],
  ["cursor", "!", "!", false],
  ["cursor", "x".repeat(4097), "x".repeat(4097), false],
])("agrees on documented %s request constraints", async (name, wire, normalized, valid) => {
  const parameter = queryParameters().find((entry) => entry.name === name);
  if (!parameter) throw new Error(`Missing documented parameter ${name}`);
  expect(validate.parameter(parameter)(normalized)).toBe(valid);
  const query = new URLSearchParams({ [name]: wire });
  if (valid) await search(query.toString());
  else
    await expectError(
      `/api/v1/ads?${query}`,
      "/api/v1/ads",
      422,
      name === "cursor" ? "INVALID_CURSOR" : "VALIDATION_ERROR",
    );
});

it("pins repeated-niche serialization, scalar uniqueness, exact names and the cross-field brand rule", async () => {
  const parameters = queryParameters();
  expect(parameters.map(({ name }) => name)).toEqual([
    "q",
    "niche",
    "format",
    "status",
    "started_after",
    "brand_id",
    "sort",
    "limit",
    "cursor",
  ]);
  expect(parameters.every((entry) => entry.in === "query" && !entry.required)).toBe(true);
  expect(parameters.find(({ name }) => name === "niche")).toMatchObject({ style: "form", explode: true });
  const repeated = await search("niche=skincare&niche=haircare&niche=skincare");
  expect(repeated.applied_filters.niche).toEqual(["haircare", "skincare"]);
  for (const query of [
    "niche[]=skincare",
    "niche[x]=skincare",
    "niche=skincare&niche=",
    "nich=skincare",
    "Q=x",
    "page=1",
    "per_page=1",
    "api_key=x",
    "sort=impressions",
  ]) {
    await expectError(`/api/v1/ads?${query}`, "/api/v1/ads", 422, "VALIDATION_ERROR");
  }
  for (const { name } of parameters.filter(({ name }) => name !== "niche")) {
    await expectError(`/api/v1/ads?${name}=x&${name}=x`, "/api/v1/ads", 422, "VALIDATION_ERROR");
  }
  await search(`sort=impressions&brand_id=${brandId}`);
  await expectError("/api/v1/ads?api_key=x", "/api/v1/ads", 401, "UNAUTHENTICATED", null);
});

it("validates genuine continuation tokens, query mismatch, tampering and the exact expiry boundary", async () => {
  const first = await search("limit=1");
  const token = first.next_cursor;
  if (token === null) throw new Error("Expected a continuation cursor");
  const cursorParameter = queryParameters().find(({ name }) => name === "cursor");
  if (!cursorParameter) throw new Error("Missing cursor schema");
  expect(validate.parameter(cursorParameter)(token)).toBe(true);
  await search(`cursor=${token}&limit=2`);
  await expectError(`/api/v1/ads?cursor=${token}&q=changed`, "/api/v1/ads", 422, "CURSOR_QUERY_MISMATCH");
  const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
  await expectError(`/api/v1/ads?cursor=${tampered}`, "/api/v1/ads", 422, "INVALID_CURSOR");
  await expectError("/api/v1/ads?cursor=syntactically_valid_but_unsupported", "/api/v1/ads", 422, "INVALID_CURSOR");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(first.cursor_expires_at));
    await expectError(`/api/v1/ads?cursor=${token}`, "/api/v1/ads", 422, "CURSOR_EXPIRED");
  } finally {
    vi.useRealTimers();
  }
});

it("validates a search execution failure rather than confusing it with authentication or empty results", async () => {
  const spy = vi.spyOn(connection.db, "transaction").mockRejectedValueOnce(new Error("private query sentinel"));
  try {
    const body = await expectError("/api/v1/ads", "/api/v1/ads", 500, "INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("private query sentinel");
  } finally {
    spy.mockRestore();
  }
});

it.each(["required-field", "enum", "status", "nested-schema"])(
  "detects incompatible %s artifact drift against actual HTTP output",
  async (drift) => {
    const actual = await search("limit=1");
    const incompatible = structuredClone(contract);
    if (drift === "required-field") {
      incompatible.components.schemas.SearchResponse.required = ["nonexistent_required_field"];
    } else if (drift === "enum") {
      incompatible.components.schemas.Sort.enum = ["unimplemented"];
    } else if (drift === "status") {
      const responses = incompatible.paths["/api/v1/ads"].get.responses;
      responses["201"] = responses["200"];
      delete responses["200"];
    } else {
      const properties = incompatible.components.schemas.AdSummary.properties as Record<string, Schema>;
      properties.headline.type = "integer";
    }
    const incompatibleValidators = validators(incompatible);
    if (drift === "status") {
      expect(() => incompatibleValidators.response("/api/v1/ads", 200)).toThrow(
        "Undocumented GET /api/v1/ads status 200",
      );
    } else {
      expect(incompatibleValidators.response("/api/v1/ads", 200)(actual)).toBe(false);
    }
  },
);

it("rejects extra public fields, missing fields, invalid formats and broken nullability in runtime bodies", async () => {
  const detail = (await request("/api/v1/ads/A", "/api/v1/ads/{id}")) as { data: Record<string, unknown> };
  const accepts = validate.response("/api/v1/ads/{id}", 200);
  for (const change of [
    { internal_secret: "not public" },
    { headline: null },
    { countries: null },
    { discovered_at: "not-a-date" },
    { end_date: "2026-02-30" },
  ]) {
    expect(accepts({ data: { ...detail.data, ...change } })).toBe(false);
  }
  const missing = structuredClone(detail);
  delete missing.data.body_text;
  expect(accepts(missing)).toBe(false);
});

type KeyMetadata = {
  id: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};
type KeyCreated = { data: KeyMetadata; secret: string };
type KeyList = { data: KeyMetadata[]; limit: number; offset: number; has_more: boolean };

async function manage(path: string, method: Method, status: number, body?: string, credential = key) {
  const operation = path.split("?")[0].startsWith("/keys/") ? "/api/v1/keys/{id}" : `/api/v1${path.split("?")[0]}`;
  const result = await request(
    `/api/v1${path}`,
    operation,
    status,
    `Bearer ${credential}`,
    {
      headers: { "Content-Type": "application/json", "Idempotency-Key": "ignored invalid value!" },
      ...(body === undefined ? {} : { body }),
    },
    method,
  );
  if (status === 422) expect(result).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  return result;
}

it("validates reveal-once creation, canonical scopes, paginated metadata and exact shared usage", async () => {
  const created: KeyCreated[] = [];
  for (const scopes of [["search:read"], ["keys:manage"], ["keys:manage", "search:read"]]) {
    const input = { scopes };
    const schema = contract.paths["/api/v1/keys"].post.requestBody?.content["application/json"].schema;
    if (!schema) throw new Error("Missing creation input schema");
    expect(validate.parameter({ name: "body", in: "body", schema })(input)).toBe(true);
    const result = (await manage("/keys", "post", 201, JSON.stringify(input))) as KeyCreated;
    expect(result.data).toMatchObject({
      prefix: result.secret.slice(0, 12),
      scopes: scopes.length === 2 ? ["search:read", "keys:manage"] : scopes,
      last_used_at: null,
      revoked_at: null,
    });
    created.push(result);
  }
  // Same ignored header did not turn three POSTs into one operation.
  expect(new Set(created.map(({ secret }) => secret)).size).toBe(3);
  const all = (await manage("/keys", "get", 200)) as KeyList;
  expect(all).toMatchObject({ limit: 20, offset: 0, has_more: false });
  expect(all.data).toHaveLength(4);
  const serialized = JSON.stringify(all);
  for (const { secret } of created) {
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(hashApiKey(secret));
  }
  expect(all.data.find(({ id }) => id === keyId)?.last_used_at).toEqual(expect.any(String));
  // Only the authenticating row may advance between reads; all other metadata
  // stays exact. Assert monotonic authentication times before normalizing that field.
  let lastUsed = Number.NEGATIVE_INFINITY;
  function snapshot(list: KeyList): KeyList {
    const caller = list.data.find(({ id }) => id === keyId);
    if (caller) {
      if (caller.last_used_at === null) throw new Error("Authenticated caller must have last_used_at");
      const observed = Date.parse(caller.last_used_at);
      expect(observed).toBeGreaterThanOrEqual(lastUsed);
      lastUsed = observed;
    }
    return { ...list, data: list.data.map((entry) => (entry.id === keyId ? { ...entry, last_used_at: null } : entry)) };
  }
  const expected = snapshot(all);
  const first = (await manage("/keys?limit=02&offset=00", "get", 200)) as KeyList;
  const last = (await manage("/keys?limit=2&offset=2", "get", 200)) as KeyList;
  expect(snapshot(first)).toEqual({ data: expected.data.slice(0, 2), limit: 2, offset: 0, has_more: true });
  expect(snapshot(last)).toEqual({ data: expected.data.slice(2), limit: 2, offset: 2, has_more: false });
  expect(await manage("/keys?limit=100&offset=99", "get", 200)).toEqual({
    data: [],
    limit: 100,
    offset: 99,
    has_more: false,
  });
  await search("q=missing");
  const usage = (await manage("/usage", "get", 200)) as { data: Record<string, unknown> };
  expect(usage.data).toMatchObject({ billable_calls: 1, quota: 1000, remaining: 999 });
  expect(usage.data.period_start).toEqual(expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/));
  expect(usage.data.period_end).toEqual(expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/));
  await manage(`/keys/${created[0].data.id}`, "delete", 204);
  const revoked = (await manage("/keys", "get", 200)) as KeyList;
  expect(revoked.data.find(({ id }) => id === created[0].data.id)?.revoked_at).toEqual(expect.any(String));
  const revokedSnapshot = snapshot(revoked);
  await manage(`/keys/${created[0].data.id}`, "delete", 204);
  expect(snapshot((await manage("/keys", "get", 200)) as KeyList)).toEqual(revokedSnapshot);
});

it.each(management)(
  "validates management %s %s authentication, scope, rate, route and server errors",
  async (operation, method) => {
    const path = operation.replace("{id}", "00000000-0000-0000-0000-000000000000");
    const options =
      method === "post" ? { headers: { "Content-Type": "application/json" }, body: '{"scopes":["keys:manage"]}' } : {};
    for (const auth of [null, "Bearer invalid", `Bearer ${await signToken(ownerId, jwtSecret)}`]) {
      await request(path, operation, 401, auth, options, method);
    }
    await connection.db
      .update(apiKeys)
      .set({ scopes: ["search:read"] })
      .where(eq(apiKeys.id, keyId));
    expect(await request(path, operation, 403, `Bearer ${key}`, options, method)).toMatchObject({
      error: { code: "INSUFFICIENT_SCOPE" },
    });
    await connection.db.execute(
      sql`UPDATE api_keys SET rate_admissions = array_fill(clock_timestamp(), ARRAY[60]) WHERE id = ${keyId}::uuid`,
    );
    await request(`${path}?unknown=x`, operation, 429, `Bearer ${key}`, options, method);
    await connection.db
      .update(apiKeys)
      .set({ scopes: ["search:read", "keys:manage"], rateAdmissions: [] })
      .where(eq(apiKeys.id, keyId));
    await request("/api/v1/unknown", operation, 404, `Bearer ${key}`, {}, method);
    const spy = vi
      .spyOn(connection.db.$client, "connect")
      .mockRejectedValueOnce(new Error("private contract sentinel"));
    try {
      const body = await request(path, operation, 500, `Bearer ${key}`, options, method);
      expect(JSON.stringify(body)).not.toContain("private contract sentinel");
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
])("rejects undocumented creation body %s in the schema and HTTP", async (body) => {
  const schema = contract.paths["/api/v1/keys"].post.requestBody?.content["application/json"].schema;
  if (!schema) throw new Error("Missing creation schema");
  expect(validate.parameter({ name: "body", in: "body", schema })(JSON.parse(body))).toBe(false);
  await manage("/keys", "post", 422, body);
});

it("validates JSON 400/413 and delegation 403 separately from invalid scope 422", async () => {
  expect(await manage("/keys", "post", 400, "{")).toMatchObject({ error: { code: "MALFORMED_JSON" } });
  expect(await manage("/keys", "post", 413, JSON.stringify({ scopes: ["x".repeat(17000)] }))).toMatchObject({
    error: { code: "BODY_TOO_LARGE" },
  });
  await connection.db
    .update(apiKeys)
    .set({ scopes: ["keys:manage"] })
    .where(eq(apiKeys.id, keyId));
  expect(await manage("/keys", "post", 403, '{"scopes":["search:read"]}')).toMatchObject({
    error: { code: "INSUFFICIENT_SCOPE" },
  });
  await manage("/keys", "post", 422, '{"scopes":["unknown"]}');
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
])("rejects strict key-list query %s over HTTP", async (query) => {
  await manage(`/keys?${query}`, "get", 422);
});

it("pins management query/path allowlists, UUIDs and missing/foreign ownership privacy", async () => {
  const listParameters = contract.paths["/api/v1/keys"].get.parameters ?? [];
  expect(listParameters).toEqual([
    { $ref: "#/components/parameters/KeyLimit" },
    { $ref: "#/components/parameters/KeyOffset" },
  ]);
  for (const [name, values] of [
    ["KeyLimit", [0, 101, 1.5]],
    ["KeyOffset", [-1, 9007199254740992, 1.5]],
  ] as const) {
    const accepts = validate.parameter(contract.components.parameters[name]);
    for (const value of values) expect(accepts(value)).toBe(false);
  }
  const uuid = validate.parameter(contract.components.parameters.KeyId);
  expect(uuid(keyId)).toBe(true);
  expect(uuid("not-a-uuid")).toBe(false);
  await manage("/keys/not-a-uuid", "delete", 422);
  await manage("/keys/%ZZ", "delete", 422);
  for (const [path, method, body] of [
    ["/usage?owner_id=foreign", "get"],
    ["/keys?extra=x", "post", '{"scopes":["search:read"]}'],
    [`/keys/${keyId}?extra=x`, "delete"],
  ] as const) {
    await manage(path, method, 422, body);
  }
  const [foreign] = await connection.db
    .insert(users)
    .values({ username: `${key}-foreign`, passwordHash: "unused" })
    .returning();
  const [target] = await connection.db
    .insert(apiKeys)
    .values(apiKeyFixture(foreign.id, hashApiKey(`${key}-foreign`)))
    .returning();
  const missing = await manage("/keys/00000000-0000-0000-0000-000000000000", "delete", 404);
  expect(missing).toMatchObject({ error: { code: "KEY_NOT_FOUND" } });
  expect(await manage(`/keys/${target.id}`, "delete", 404)).toEqual(missing);
});

it.each(paths)("validates scope 403 and rolling rate 429 for %s", async (operation) => {
  const path = operation.replace("{id}", "A");
  await connection.db
    .update(apiKeys)
    .set({ scopes: ["keys:manage"] })
    .where(eq(apiKeys.id, keyId));
  await expectError(path, operation, 403, "INSUFFICIENT_SCOPE");
  await connection.db.execute(
    sql`UPDATE api_keys SET rate_admissions = array_fill(clock_timestamp(), ARRAY[60]) WHERE id = ${keyId}::uuid`,
  );
  const body = await request(path, operation, 429);
  expect(body).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true } });
});

it.each(paths.slice(0, 2))(
  "validates billing header syntax, 409 precedence and quota reset details for %s",
  async (operation) => {
    const path = operation.replace("{id}", "A");
    const header = contract.components.parameters.IdempotencyKey;
    expect(header).toMatchObject({ name: "Idempotency-Key", in: "header", required: false });
    const accepts = validate.parameter(header);
    for (const value of ["a", "A0._:-", "x".repeat(128)]) {
      expect(accepts(value)).toBe(true);
      await request(path, operation, 200, `Bearer ${key}`, { headers: { "iDeMpOtEnCy-KeY": value } });
    }
    for (const value of ["", "bad value!", "x".repeat(129)]) {
      expect(accepts(value)).toBe(false);
      await request(path, operation, 422, `Bearer ${key}`, { headers: { "Idempotency-Key": value } });
    }
    // Node's raw header array sends two physical fields; fetch would coalesce them.
    const duplicate = await new Promise<{ status: number; body: unknown; cache: string | string[] | undefined }>(
      (resolve, reject) => {
        const req = httpRequest(
          `${origin}${path}`,
          {
            headers: [
              "Host",
              new URL(origin).host,
              "Authorization",
              `Bearer ${key}`,
              "Idempotency-Key",
              "one",
              "Idempotency-Key",
              "two",
            ],
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(text), cache: res.headers["cache-control"] }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(duplicate.status).toBe(422);
    expect(duplicate.cache).toBe("no-store");
    expect(validate.response(operation, 422)(duplicate.body)).toBe(true);
    await connection.db.execute(sql`UPDATE monthly_usage SET count = 1000 WHERE owner_id = ${ownerId}::uuid`);
    const changed = operation.endsWith("{id}") ? "/api/v1/ads/B" : "/api/v1/ads?limit=1";
    expect(
      await request(changed, operation, 409, `Bearer ${key}`, { headers: { "Idempotency-Key": "a" } }),
    ).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT", retryable: false, details: [] } });
    await request(path, operation, 200, `Bearer ${key}`, { headers: { "Idempotency-Key": "a" } });
    const quota = (await request(path, operation, 403)) as {
      error: { code: string; message: string; details: { suggestion: string }[] };
    };
    expect(quota.error.code).toBe("QUOTA_EXCEEDED");
    const usage = (await manage("/usage", "get", 200)) as {
      data: { period_end: string; billable_calls: number; remaining: number };
    };
    expect(quota.error.details).toEqual([
      { parameter: "quota", reason: "monthly_quota_exceeded", allowed_values: [], suggestion: usage.data.period_end },
    ]);
    expect(quota.error.message).toContain(usage.data.period_end);
    const acceptsQuota = validate.response(operation, 403);
    expect(acceptsQuota({ error: { ...quota.error, details: [] } })).toBe(false);
    expect(
      acceptsQuota({ error: { ...quota.error, details: [{ ...quota.error.details[0], suggestion: "not-a-date" }] } }),
    ).toBe(false);
    expect(usage.data).toMatchObject({ billable_calls: 1000, remaining: 0 });
  },
);

it("detects management output allowlist, required-field, timestamp and nullability drift", async () => {
  const actual = (await manage("/keys", "post", 201, '{"scopes":["search:read"]}')) as KeyCreated;
  const accepts = validate.response("/api/v1/keys", 201, "post");
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
  delete missing.last_used_at;
  expect(accepts({ ...actual, data: missing })).toBe(false);
  const usage = (await manage("/usage", "get", 200)) as { data: Record<string, unknown> };
  expect(validate.response("/api/v1/usage", 200)({ data: { ...usage.data, per_key: [] } })).toBe(false);
});

it("compiles every documented response with draft-2020-12 formats and local references", () => {
  expect(contract.openapi).toMatch(/^3\.1\./);
  expect(Object.keys(contract.paths)).toEqual([...paths, "/api/v1/keys", "/api/v1/keys/{id}", "/api/v1/usage"]);
  expect(contract.security).toEqual([{ BearerApiKey: [] }]);
  expect(contract.components.securitySchemes.BearerApiKey).toEqual({ type: "http", scheme: "bearer" });
  for (const [path, operations] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      for (const status of Object.keys(operation.responses)) {
        if (status === "204") continue;
        expect(validate.response(path, Number(status), method as Method)).toBeTypeOf("function");
      }
    }
  }
});
