import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";

import type { CursorQuery } from "../src/ads/v1/cursor.js";
import { sendError } from "../src/ads/v1/errors.js";
import { normalizeParameters, parseParameters, validateParameters } from "../src/ads/v1/parameters.js";

function validate(entries: Record<string, string> | [string, string][]) {
  const parsed = parseParameters(new URLSearchParams(entries));
  if (parsed.error) throw new Error("Test expected structurally valid parameters");
  return validateParameters(parsed.value);
}

const names = ["q", "niche", "format", "status", "started_after", "brand_id", "sort", "limit", "cursor"];

function normalize(entries: Record<string, string> | [string, string][], original?: CursorQuery) {
  const validated = validate(entries);
  return validated.error ? validated : normalizeParameters(validated.value, original);
}

const defaults: CursorQuery = {
  q: "",
  niche: [],
  format: null,
  status: null,
  startedAfter: null,
  brandId: null,
  sort: "newest",
};
const original: CursorQuery = {
  q: "Serum  %_\\",
  niche: ["fitness", "skincare"],
  format: "video",
  status: "active",
  startedAfter: "2024-02-29",
  brandId: 12,
  sort: "impressions",
};

describe("safe search error guidance", () => {
  it.each(["INVALID_CURSOR", "CURSOR_EXPIRED", "CURSOR_QUERY_MISMATCH"] as const)(
    "formats %s with fresh-search guidance",
    (code) => {
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      sendError(res as unknown as Response, code);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code,
          message: expect.any(String),
          next_action: expect.stringMatching(/fresh|new search/i),
          retryable: false,
          details: [],
        },
      });
    },
  );

  it("gives actionable brand and niche guidance for invalid search values", () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const error = normalize({ sort: "impressions" }).error;
    if (!error) throw new Error("Expected missing-brand diagnostic");
    sendError(res as unknown as Response, error.code, error.details);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "VALIDATION_ERROR",
        message: expect.any(String),
        next_action: expect.stringMatching(/brand_id.*sort=newest/),
        retryable: false,
        details: error.details,
      },
    });
  });
});

describe("effective v1 search normalization", () => {
  it("applies defaults only after validation and does not add a cursor", () => {
    expect(normalize({})).toEqual({ value: { query: defaults, limit: 20, cursor: undefined } });
    expect(normalize({ q: "   " })).toEqual(normalize({}));
  });

  it("trims q without case folding, whitespace folding or SQL pattern interpretation", () => {
    expect(normalize({ q: "  Serum  %_\\  " }).value?.query.q).toBe("Serum  %_\\");
  });

  it.each(["\0", "ser\0um", "\0serum", "serum\0"])("rejects NUL in q before normalization: %j", (q) => {
    const expected = {
      error: {
        code: "VALIDATION_ERROR",
        details: [{ parameter: "q", reason: "invalid_text", allowed_values: [], suggestion: null }],
      },
    };
    expect(normalize({ q })).toEqual(expected);
    expect(normalize({ q, cursor: "opaque" }, original)).toEqual(expected);
  });

  it("normalizes numeric spellings and deduplicates/sorts niches without mutating validation output", () => {
    const validated = validate([
      ["niche", "skincare"],
      ["niche", "fitness"],
      ["niche", "skincare"],
      ["brand_id", "0012"],
      ["limit", "0001"],
    ]);
    if (validated.error) throw new Error("Expected valid input");
    expect(normalizeParameters(validated.value).value).toEqual({
      query: { ...defaults, niche: ["fitness", "skincare"], brandId: 12 },
      limit: 1,
      cursor: undefined,
    });
    expect(validated.value.niche).toEqual(["skincare", "fitness", "skincare"]);
  });

  it("requires a brand only for effective impressions sorting", () => {
    expect(normalize({ sort: "impressions" }).error).toEqual({
      code: "VALIDATION_ERROR",
      details: [{ parameter: "brand_id", reason: "required_for_impressions", allowed_values: [], suggestion: null }],
    });
    expect(normalize({ sort: "impressions", brand_id: "1" })).toHaveProperty("value.query.brandId", 1);
    expect(normalize({ sort: "newest" })).toHaveProperty("value");
  });

  it("inherits omitted continuation filters, but resets the independent limit to 20", () => {
    expect(normalize({ cursor: "opaque" }, original)).toEqual({
      value: { query: original, cursor: "opaque", limit: 20 },
    });
    expect(normalize({ cursor: "opaque", limit: "100" }, original).value?.limit).toBe(100);
  });

  it.each([
    { q: "  Serum  %_\\  " },
    { niche: "fitness" },
    { format: "video" },
    { status: "active" },
    { started_after: "2024-02-29" },
    { brand_id: "0012" },
    { sort: "impressions" },
  ])("compares partial supplied repeats after normalization: %j", (repeated) => {
    const entries: [string, string][] = Object.entries(repeated);
    if (repeated.niche) entries.push(["niche", "skincare"], ["niche", "fitness"]);
    expect(normalize([["cursor", "opaque"], ...entries], original).value?.query).toEqual(original);
  });

  it.each([
    ["q", "serum  %_\\"],
    ["q", ""],
    ["niche", "fitness"],
    ["format", "image"],
    ["status", "inactive"],
    ["started_after", "2024-03-01"],
    ["brand_id", "13"],
    ["sort", "newest"],
  ])("rejects changed query identity %s=%s", (name, value) => {
    expect(normalize({ cursor: "opaque", [name]: value }, original).error).toEqual({
      code: "CURSOR_QUERY_MISMATCH",
      details: [],
    });
  });

  it("allows equivalent explicit defaults when originals used defaults", () => {
    expect(normalize({ q: " ", sort: "newest", limit: "0020" }, defaults).value?.query).toEqual(defaults);
  });

  it.each([
    { niche: "Skincare" },
    { format: "VIDEO" },
    { status: "" },
    { started_after: "2026-02-30" },
    { brand_id: "+12" },
    { sort: "Impressions" },
    { q: "a".repeat(501) },
    { limit: "101" },
  ])("rejects invalid supplied values before comparison: %j", (invalid) => {
    expect(normalize({ cursor: "opaque", ...invalid }, original).error?.code).toBe("VALIDATION_ERROR");
  });

  it("does not mutate the original query while matching or rejecting repeats", () => {
    const before = JSON.stringify(original);
    normalize({ cursor: "opaque", niche: "fitness" }, original);
    normalize({ cursor: "opaque", q: "new" }, original);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("v1 search value validation", () => {
  it("leaves presence, whitespace, numeric spelling and niche ordering for normalization", () => {
    expect(
      validate([
        ["q", "  Serum  "],
        ["brand_id", "0012"],
        ["niche", "skincare"],
        ["niche", "fitness"],
      ]),
    ).toEqual({
      value: { q: "  Serum  ", brand_id: "0012", niche: ["skincare", "fitness"] },
    });
    expect(validate({})).toEqual({ value: {} });
  });

  it.each(["format", "status", "sort", "niche"])("rejects empty %s with allowed values", (name) => {
    const result = validate({ [name]: "" });
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect(result.error?.details[0]).toMatchObject({ parameter: name, reason: "invalid_value", suggestion: null });
    expect(result.error?.details[0].allowed_values.length).toBeGreaterThan(0);
  });

  it.each([
    ["format", "Video"],
    ["format", "gif"],
    ["status", "ACTIVE"],
    ["sort", "Newest"],
    ["niche", "skincare,fitness"],
    ["niche", " skincare"],
    ["niche", "SKINCARE"],
  ])("rejects noncanonical %s=%s", (name, value) => {
    expect(validate({ [name]: value })).toHaveProperty("error.code", "VALIDATION_ERROR");
  });

  it.each([
    ["Skincare", "skincare"],
    ["Pet Supplies", "pet-supplies"],
  ])("suggests %s without repair", (value, suggestion) => {
    expect(validate({ niche: value }).error?.details[0]).toMatchObject({
      parameter: "niche",
      suggestion,
      allowed_values: expect.arrayContaining([suggestion]),
    });
  });

  it("validates every niche before deduplicating or sorting", () => {
    expect(
      validate([
        ["niche", "skincare"],
        ["niche", ""],
        ["niche", "skincare"],
      ]),
    ).toHaveProperty("error");
  });

  it.each(["", "0", "-1", "+1", " 1", "1 ", "1.0", "1e1", "0x10", "１", "١", "NaN", "Infinity", "9".repeat(400)])(
    "rejects strict numeric syntax or bounds %s",
    (value) => {
      for (const name of ["brand_id", "limit"]) expect(validate({ [name]: value })).toHaveProperty("error");
    },
  );

  it.each([
    ["brand_id", "2147483647"],
    ["brand_id", "0001"],
    ["limit", "100"],
    ["limit", "001"],
  ])("accepts numeric boundary %s=%s", (name, value) => expect(validate({ [name]: value })).toHaveProperty("value"));
  it.each([
    ["brand_id", "2147483648"],
    ["limit", "101"],
  ])("rejects overflow %s=%s", (name, value) => {
    expect(validate({ [name]: value })).toHaveProperty("error");
  });

  it.each(["0001-01-01", "9999-12-31", "2000-02-29", "2024-02-29", "2026-02-28", "0099-12-31", "2400-02-29"])(
    "accepts Gregorian date %s",
    (date) => expect(validate({ started_after: date })).toHaveProperty("value"),
  );
  it.each([
    "",
    "0000-01-01",
    "10000-01-01",
    "1900-02-29",
    "2100-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-1-01",
    "2026-01-01T00:00:00Z",
    " 2026-01-01",
  ])("rejects non-calendar date %s", (date) => expect(validate({ started_after: date })).toHaveProperty("error"));

  it("counts trimmed Unicode code points rather than UTF-16 units or UTF-8 bytes", () => {
    for (const char of ["a", "é", "😀"]) {
      expect(validate({ q: `  ${char.repeat(500)}  ` })).toHaveProperty("value");
      expect(validate({ q: char.repeat(501) })).toHaveProperty("error");
    }
    expect(validate({ q: "   " })).toHaveProperty("value");
    expect(validate({ q: "" })).toHaveProperty("value");
  });

  it.each(["", "not a token", "a".repeat(4097), "é", "abc="])("rejects invalid cursor boundary %s", (cursor) => {
    const result = validate({ cursor });
    expect(result.error).toEqual({ code: "INVALID_CURSOR", details: [] });
    if (cursor) expect(JSON.stringify(result)).not.toContain(cursor);
  });
});

describe("raw v1 search parsing", () => {
  it("preserves omitted versus supplied empty parameters without applying defaults", () => {
    expect(parseParameters(new URLSearchParams())).toEqual({ value: {} });
    expect(parseParameters(new URLSearchParams("q=&niche=&limit="))).toEqual({
      value: { q: "", niche: [""], limit: "" },
    });
  });

  it("preserves every repeated niche for later validation", () => {
    expect(parseParameters(new URLSearchParams("niche=skincare&niche=fitness&niche=skincare"))).toEqual({
      value: { niche: ["skincare", "fitness", "skincare"] },
    });
  });

  it.each(names.filter((name) => name !== "niche"))("rejects duplicate scalar %s even when equal", (name) => {
    expect(parseParameters(new URLSearchParams(`${name}=same&${name}=same`))).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ parameter: name, reason: "duplicate_parameter", allowed_values: [], suggestion: null }],
      },
    });
  });

  it.each(["Niche", "niche[]", "niche[x]", "page", "per_page", "api_key", "__proto__", "💥"])(
    "rejects literal unknown name %s without reflecting it",
    (name) => {
      const result = parseParameters(new URLSearchParams([[name, "private-value"]]));
      expect(result).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          details: [{ parameter: "query", reason: "unknown_parameter", allowed_values: names, suggestion: null }],
        },
      });
      expect(JSON.stringify(result)).not.toContain("private-value");
    },
  );

  it("suggests the agreed nich correction without repairing the request", () => {
    expect(parseParameters(new URLSearchParams("nich=skincare"))).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ parameter: "query", reason: "unknown_parameter", allowed_values: names, suggestion: "niche" }],
      },
    });
  });

  it("uses decoded names but never interprets brackets as arrays", () => {
    expect(parseParameters(new URLSearchParams("%71=Hello+World"))).toEqual({ value: { q: "Hello World" } });
    expect(parseParameters(new URLSearchParams("niche%5B%5D=fitness"))).toHaveProperty("error");
  });
});
