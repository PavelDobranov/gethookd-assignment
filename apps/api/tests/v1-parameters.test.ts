import { describe, expect, it } from "vitest";

import { parseV1Parameters } from "../src/ads/v1-parameters.js";

const names = ["q", "niche", "format", "status", "started_after", "brand_id", "sort", "limit", "cursor"];

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
