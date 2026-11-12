import { describe, expect, it } from "vitest";

import { parseV1Parameters, validateV1Parameters } from "../src/ads/v1-parameters.js";

function validate(entries: Record<string, string> | [string, string][]) {
  const parsed = parseV1Parameters(new URLSearchParams(entries));
  if (parsed.error) throw new Error("Test expected structurally valid parameters");
  return validateV1Parameters(parsed.value);
}

const names = ["q", "niche", "format", "status", "started_after", "brand_id", "sort", "limit", "cursor"];

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
    expect(parseV1Parameters(new URLSearchParams())).toEqual({ value: {} });
    expect(parseV1Parameters(new URLSearchParams("q=&niche=&limit="))).toEqual({
      value: { q: "", niche: [""], limit: "" },
    });
  });

  it("preserves every repeated niche for later validation", () => {
    expect(parseV1Parameters(new URLSearchParams("niche=skincare&niche=fitness&niche=skincare"))).toEqual({
      value: { niche: ["skincare", "fitness", "skincare"] },
    });
  });

  it.each(names.filter((name) => name !== "niche"))("rejects duplicate scalar %s even when equal", (name) => {
    expect(parseV1Parameters(new URLSearchParams(`${name}=same&${name}=same`))).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ parameter: name, reason: "duplicate_parameter", allowed_values: [], suggestion: null }],
      },
    });
  });

  it.each(["Niche", "niche[]", "niche[x]", "page", "per_page", "api_key", "__proto__", "💥"])(
    "rejects literal unknown name %s without reflecting it",
    (name) => {
      const result = parseV1Parameters(new URLSearchParams([[name, "private-value"]]));
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
    expect(parseV1Parameters(new URLSearchParams("nich=skincare"))).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ parameter: "query", reason: "unknown_parameter", allowed_values: names, suggestion: "niche" }],
      },
    });
  });

  it("uses decoded names but never interprets brackets as arrays", () => {
    expect(parseV1Parameters(new URLSearchParams("%71=Hello+World"))).toEqual({ value: { q: "Hello World" } });
    expect(parseV1Parameters(new URLSearchParams("niche%5B%5D=fitness"))).toHaveProperty("error");
  });
});
