import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseAdParameters } from "../src/ads/v0/parameters.js";
import type { CursorQuery } from "../src/ads/v1/cursor.js";
import { normalizeParameters, parseParameters, validateParameters } from "../src/ads/v1/parameters.js";
import { billingBinding, fingerprintRequest, parseIdempotencyKeyHash } from "../src/usage/identity.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function v0(query: string) {
  const parameters = parseAdParameters(new URLSearchParams(`api_key=secret&${query}`));
  if (!parameters) throw new Error("Invalid fixture");
  return { operation: "v0.search" as const, parameters };
}
function v1(query: string, original?: CursorQuery) {
  const parsed = parseParameters(new URLSearchParams(query));
  if (parsed.error) throw new Error("Invalid fixture");
  const validated = validateParameters(parsed.value);
  if (validated.error) throw new Error("Invalid fixture");
  const normalized = normalizeParameters(validated.value, original);
  if (normalized.error) throw new Error("Invalid fixture");
  return { operation: "v1.search" as const, parameters: normalized.value };
}

describe("optional raw Idempotency-Key", () => {
  it.each([
    [[], undefined],
    [["Authorization", "Bearer sensitive"], undefined],
    [["Idempotency-Key", "a._:-09AZaz"], hash("a._:-09AZaz")],
    [["iDeMpOtEnCy-KeY", "\t opaque \t"], hash("opaque")],
    [["Idempotency-Key", "a".repeat(128)], hash("a".repeat(128))],
  ])("parses %j without exposing its value", (headers, expected) => {
    expect(parseIdempotencyKeyHash(headers)).toBe(expected);
  });
  it.each(["", " ", "a".repeat(129), "a b", "a\tb", "café", "a,b", "a/b", "a\n", "a\r", "a\0", "a\u007f", "\u00a0a"])(
    "rejects malformed value %j with a sanitized domain failure",
    (value) => {
      expect(() => parseIdempotencyKeyHash(["Idempotency-Key", value])).toThrow("Invalid Idempotency-Key.");
      try {
        parseIdempotencyKeyHash(["Idempotency-Key", value]);
      } catch (error) {
        expect(error).toMatchObject({ code: "VALIDATION_ERROR", parameter: "Idempotency-Key" });
      }
    },
  );
  it.each(["same", "different"])("rejects case-insensitive duplicate names (%s)", (second) => {
    expect(() => parseIdempotencyKeyHash(["Idempotency-Key", "same", "IDEMPOTENCY-KEY", second])).toThrow();
  });
  it("keeps values case-sensitive and never generates a binding when absent", () => {
    expect(parseIdempotencyKeyHash(["Idempotency-Key", "A"])).not.toBe(
      parseIdempotencyKeyHash(["Idempotency-Key", "a"]),
    );
    expect(billingBinding([], v0(""))).toBeUndefined();
    expect(billingBinding(["Idempotency-Key", "intent"], v0(""))).toEqual({
      valueHash: hash("intent"),
      fingerprintHash: fingerprintRequest(v0("")),
    });
  });
});

describe("effective canonical fingerprints", () => {
  it.each([
    ["", "page=01&per_page=020"],
    ["per_page=100", "per_page=999"],
    ["", "niche=invalid&format=invalid&status=invalid&ignored=value"],
    ["niche=skincare", "niche=SKINCARE"],
    ["q=Case++inside&status=active", "status=active&q=Case++inside"],
  ])("uses v0 effective meaning: %s = %s", (first, second) => {
    expect(fingerprintRequest(v0(first))).toBe(fingerprintRequest(v0(second)));
  });
  it("allowlists v0 fields, excluding credentials and extra raw properties", () => {
    const request = v0("");
    expect(fingerprintRequest({ ...request, parameters: { ...request.parameters, apiKey: "different-secret" } })).toBe(
      fingerprintRequest(request),
    );
    expect(fingerprintRequest(request)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    ["", "sort=newest&limit=020&q="],
    ["q=+Hello++World+&niche=skincare&niche=fitness", "niche=fitness&q=Hello++World&niche=skincare&niche=skincare"],
    ["brand_id=001&limit=01&sort=impressions", "sort=impressions&limit=1&brand_id=1"],
  ])("uses v1 normalization and stable field order: %s = %s", (first, second) => {
    expect(fingerprintRequest(v1(first))).toBe(fingerprintRequest(v1(second)));
  });
  it.each([
    "q=hello",
    "q=Hello+World",
    "q=Hello++World",
    "limit=21",
    "brand_id=1",
    "sort=impressions&brand_id=1",
    "niche=skincare",
    "format=video",
    "status=active",
    "started_after=2028-01-01",
  ])("retains meaningful v1 changes: %s", (query) => {
    expect(fingerprintRequest(v1(query))).not.toBe(fingerprintRequest(v1("")));
  });
  it.each([
    ["q=A", "q=a"],
    ["q=A++B", "q=A+B"],
    ["q=+A+", "q=A"],
    ["page=1", "page=2"],
    ["per_page=20", "per_page=21"],
  ])("retains meaningful v0 changes: %s != %s", (first, second) => {
    expect(fingerprintRequest(v0(first))).not.toBe(fingerprintRequest(v0(second)));
  });
  it.each([
    ["q=Case", "q=case"],
    ["q=A++B", "q=A+B"],
  ])("preserves meaningful v1 text: %s != %s", (first, second) => {
    expect(fingerprintRequest(v1(first))).not.toBe(fingerprintRequest(v1(second)));
  });
  it("inherits continuation meaning, allows partial equivalent repeats and retains the supplied cursor and limit", () => {
    const original = v1("q=Hello++World&niche=skincare&brand_id=1&sort=impressions&status=active").parameters.query;
    const cursorOnly = v1("cursor=opaque.token", original);
    expect(fingerprintRequest(cursorOnly)).toBe(
      fingerprintRequest(v1("cursor=opaque.token&brand_id=01&q=+Hello++World+&sort=impressions", original)),
    );
    for (const query of ["cursor=other.token", "cursor=opaque.token&limit=21", ""]) {
      expect(fingerprintRequest(v1(query, original))).not.toBe(fingerprintRequest(cursorOnly));
    }
  });
  it("uses allowlisted normalized fields, not object insertion order or response-generated metadata", () => {
    const request = v1("");
    const parameters = {
      cursor: undefined,
      limit: 20,
      query: { ...request.parameters.query },
      nextCursor: "new-each-attempt",
      snapshot: "now",
    };
    expect(fingerprintRequest({ ...request, parameters })).toBe(fingerprintRequest(request));
  });
  it("separates versions and operations, preserving exact once-decoded opaque detail IDs", () => {
    const detail = (id: string) => fingerprintRequest({ operation: "v1.detail", id });
    expect(fingerprintRequest(v0(""))).not.toBe(fingerprintRequest(v1("")));
    expect(detail("")).not.toBe(fingerprintRequest(v1("")));
    const ids = ["opaque /?# + café", "%FF", "000123", "123", "A", "a", " a ", "%2F", "/", "x\ny"];
    expect(new Set(ids.map(detail)).size).toBe(ids.length);
    expect(detail("opaque /?# + café")).toBe(detail(decodeURIComponent("opaque%20%2F%3F%23%20%2B%20caf%C3%A9")));
  });
});
