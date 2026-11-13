import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { parse } from "yaml";

import { niches } from "../src/ads/model.js";
import { hashApiKey } from "../src/api-keys/index.js";
import { createApp } from "../src/app.js";
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
type Operation = {
  parameters?: Parameter[];
  responses: Record<string, { $ref?: string; content?: { "application/json": { schema: Schema } } }>;
};
type Contract = {
  openapi: string;
  security: { BearerApiKey: never[] }[];
  paths: Record<string, { get: Operation }>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, { content: { "application/json": { schema: Schema } } }>;
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
    response(path: string, status: number) {
      const response = document.paths[path].get.responses[String(status)];
      if (!response) throw new Error(`Undocumented GET ${path} status ${status}`);
      const resolved = response.$ref
        ? document.components.responses[response.$ref.replace("#/components/responses/", "")]
        : response;
      const schema = resolved.content?.["application/json"].schema;
      if (!schema) throw new Error(`Missing JSON schema for GET ${path} status ${status}`);
      return ajv.compile(schema);
    },
    parameter(parameter: Parameter) {
      return ajv.compile(parameter.schema);
    },
  };
}

const validate = validators(contract);
const paths = ["/api/v1/ads", "/api/v1/ads/{id}", "/api/v1/niches"];
const url = new URL(inject("postgresUrl"));
url.pathname = "/gethookd_v1_openapi_test";
const connection = createDatabase(url.href);
let key: string;
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
  server = createApp({ db: connection.db, jwtSecret: "public-v1-openapi-jwt-secret-32-bytes" }).listen(0, "127.0.0.1");
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
  await connection.db.insert(apiKeys).values(apiKeyFixture(owner.id, hashApiKey(key), key.slice(0, 12)));
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await connection.close();
});

async function request(path: string, operation: string, status = 200, authorization: string | null = `Bearer ${key}`) {
  const response = await fetch(`${origin}${path}`, {
    headers: authorization === null ? {} : { Authorization: authorization },
  });
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  const body: unknown = await response.json();
  const accepts = validate.response(operation, response.status);
  expect(accepts(body), JSON.stringify(accepts.errors)).toBe(true);
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
  const catalog = await request("/api/v1/niches", "/api/v1/niches");
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
  const parameters = contract.paths["/api/v1/ads"].get.parameters ?? [];
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
  const spy = vi.spyOn(connection.db, "select").mockImplementationOnce(() => {
    throw new Error("private SQL sentinel");
  });
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
  const parameter = contract.paths["/api/v1/ads"].get.parameters?.find((entry) => entry.name === name);
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
  const parameters = contract.paths["/api/v1/ads"].get.parameters ?? [];
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
  const cursorParameter = contract.paths["/api/v1/ads"].get.parameters?.find(({ name }) => name === "cursor");
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

it("compiles every documented response with draft-2020-12 formats and local references", () => {
  expect(contract.openapi).toMatch(/^3\.1\./);
  expect(Object.keys(contract.paths)).toEqual(paths);
  expect(contract.security).toEqual([{ BearerApiKey: [] }]);
  expect(contract.components.securitySchemes.BearerApiKey).toEqual({ type: "http", scheme: "bearer" });
  for (const path of paths) {
    for (const status of Object.keys(contract.paths[path].get.responses)) {
      expect(status).not.toBe("429");
      expect(validate.response(path, Number(status))).toBeTypeOf("function");
    }
  }
});
