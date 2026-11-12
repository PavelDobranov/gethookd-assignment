import { describe, expect, it } from "vitest";

import { type CursorInput, createCursorCodec } from "../src/ads/cursor.js";

const secret = "test-only-independent-cursor-secret-123456";
const firstPageTime = Date.parse("2026-10-03T12:00:00.000Z");
const lifetime = 30 * 60 * 1000;
const input: CursorInput = {
  query: {
    q: "Serum %_\\",
    niche: ["haircare", "skincare"],
    format: "video",
    status: "active",
    startedAfter: "2024-02-29",
    brandId: null,
    sort: "newest",
  },
  snapshot: "9007199254740993:9007199254741000:9007199254740995,9007199254740997",
  position: { startDate: "2026-10-01", id: "opaque/广告-α" },
};

function codec(now = firstPageTime) {
  return createCursorCodec({ secret, now: () => now });
}

describe("v1 stateless cursor", () => {
  it("round trips newest with string snapshot IDs and opaque text ad IDs", () => {
    const token = codec().issue(input);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(4096);
    expect(codec().decode(token)).toEqual({
      ...input,
      issuedAt: firstPageTime,
      expiresAt: firstPageTime + lifetime,
    });
  });

  it.each([1, 2147483647, null])("round trips impressions position %s", (rank) => {
    const impressions: CursorInput = {
      ...input,
      query: { ...input.query, sort: "impressions", brandId: 12 },
      position: { rank, id: "ad-null-or-known" },
    };
    expect(codec().decode(codec().issue(impressions))).toMatchObject(impressions);
  });

  it("uses fresh 12-byte nonces and supports replay after same-secret reconstruction", () => {
    const first = codec().issue(input);
    const second = codec().issue(input);
    expect(Buffer.from(first, "base64url").subarray(1, 13)).not.toEqual(
      Buffer.from(second, "base64url").subarray(1, 13),
    );
    expect(first).not.toEqual(second);
    expect(codec().decode(first)).toEqual(codec().decode(second));
    expect(codec().decode(first)).toEqual(codec().decode(first));
  });

  it("expires exactly 30 minutes after the first page without renewing on continuation", () => {
    const token = codec().issue(input);
    const continuation = codec(firstPageTime + lifetime - 1);
    const state = continuation.decode(token);
    const next = continuation.encode({ ...state, position: { startDate: "2026-09-30", id: "next" } });
    expect(continuation.decode(next).expiresAt).toBe(firstPageTime + lifetime);
    expect(() => codec(firstPageTime + lifetime).decode(next)).toThrowError(
      expect.objectContaining({ code: "CURSOR_EXPIRED", message: expect.stringContaining("fresh search") }),
    );
  });

  it("rejects wrong secrets actionably without exposing crypto diagnostics", () => {
    const rotated = createCursorCodec({ secret: "different-test-only-cursor-secret-123456", now: () => firstPageTime });
    expect(() => rotated.decode(codec().issue(input))).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR", message: expect.stringContaining("fresh search") }),
    );
  });
});
