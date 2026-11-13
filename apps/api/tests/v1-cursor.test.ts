import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { type CursorInput, createCursorCodec } from "../src/ads/v1/cursor.js";

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
  position: { startDate: "2026-10-01", id: "opaque/广告-α-😀" },
};

function codec(now = firstPageTime) {
  return createCursorCodec({ secret, now: () => now });
}

// Independent authenticated fixtures exercise validation *after* successful GCM
// verification. Fixed nonce is only for these test vectors, never production.
function seal(value: unknown, tag?: Buffer, context = "gethookd:ads:cursor:v1") {
  const key = createHash("sha256").update("gethookd:ads:cursor:key:v1\0").update(secret).digest();
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const plaintext = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, ciphertext, tag ?? cipher.getAuthTag()]).toString("base64url");
}

function expectInvalid(token: string, now = firstPageTime) {
  expect(() => codec(now).decode(token)).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
}

function state() {
  return { ...input, issuedAt: firstPageTime, expiresAt: firstPageTime + lifetime };
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

  it.each([0, 1, 13, -1])("rejects changed version/nonce/ciphertext/tag at byte %s", (index) => {
    const envelope = Buffer.from(codec().issue(input), "base64url");
    const offset = index < 0 ? envelope.length + index : index;
    envelope[offset] ^= 1;
    expectInvalid(envelope.toString("base64url"));
  });

  it.each([
    { query: { ...input.query, q: "other query" } },
    { position: { startDate: "2026-09-30", id: "altered-position" } },
    { expiresAt: firstPageTime + lifetime * 2 },
    { snapshot: "1:2:" },
  ])("rejects changed query, position, expiry or snapshot without a new tag: %j", (change) => {
    const original = seal(state());
    const tag = Buffer.from(original, "base64url").subarray(-16);
    expectInvalid(seal({ ...state(), ...change }, tag));
  });

  it("authenticates context and authenticates before reporting expiry", () => {
    expectInvalid(seal(state(), undefined, "other-feature:v1"));
    const envelope = Buffer.from(codec().issue(input), "base64url");
    envelope[13] ^= 1;
    expectInvalid(envelope.toString("base64url"), firstPageTime + lifetime);
    expectInvalid(seal({ ...state(), expiresAt: 0 }), firstPageTime + lifetime);
  });

  it.each(["", " ", "é", "a=b", "a+b", "a/b", "a.b", "a\n", "A", "AA", "A".repeat(4097)])(
    "rejects malformed or oversized input %j",
    (token) => expectInvalid(token),
  );

  it("rejects noncanonical base64url, truncated envelopes and appended data", () => {
    const token = codec().issue(input);
    expectInvalid(`${token}=`);
    expectInvalid(token.slice(0, -1));
    expectInvalid(`${token}AA`);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // Use a valid authenticated token with unused pad bits, not a truncated
    // fixture that would already fail authentication regardless of spelling.
    const canonical = [1, 2, 3]
      .map((length) =>
        seal({
          ...state(),
          position: { startDate: "2026-01-01", id: "x".repeat(length) },
        }),
      )
      .find((candidate) => Buffer.from(candidate, "base64url").length % 3 === 1);
    expect(canonical).toBeDefined();
    if (!canonical) throw new Error("Missing padded test vector");
    const last = alphabet.indexOf(canonical.at(-1) ?? "");
    const alias = canonical.slice(0, -1) + alphabet[last + 1];
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(canonical, "base64url"));
    expectInvalid(alias);
  });

  it.each([
    Buffer.from("{"),
    Buffer.from([0xff]),
    null,
    [],
    "payload",
    {},
    { ...state(), apiKey: "test-only-forbidden-credential" },
    { ...state(), issuedAt: "2026-10-03T12:00:00Z" },
    { ...state(), issuedAt: -1 },
    { ...state(), issuedAt: firstPageTime + 0.5 },
    { ...state(), expiresAt: firstPageTime + lifetime + 1 },
    { ...state(), expiresAt: 8640000000000001 },
    { ...state(), snapshot: null },
    { ...state(), position: { startDate: "2026-02-30", id: "ad" } },
    { ...state(), position: { rank: 1, id: "ad" } },
    { ...state(), position: { startDate: "2026-01-01", id: 1 } },
    { ...state(), position: { startDate: "2026-01-01", id: "" } },
    { ...state(), position: { startDate: "2026-01-01", id: "ad\0id" } },
    { ...state(), position: { startDate: "2026-01-01", id: "\ud800" } },
    { ...state(), position: { startDate: "2026-01-01", id: "\udfff" } },
    { ...state(), position: { startDate: "2026-01-01", id: "ad", rank: null } },
  ])("rejects authenticated malformed payload %j", (payload) => expectInvalid(seal(payload)));

  it.each([
    { q: " not trimmed " },
    { q: "x".repeat(501) },
    { q: 12 },
    { niche: ["skincare", "haircare"] },
    { niche: ["skincare", "skincare"] },
    { niche: ["Skincare"] },
    { niche: "skincare" },
    { format: "Video" },
    { status: "unknown" },
    { startedAfter: "1900-02-29" },
    { startedAfter: "0000-01-01" },
    { startedAfter: "2026-01-01T00:00:00Z" },
    { brandId: 0 },
    { brandId: 2147483648 },
    { brandId: "1" },
    { brandId: 1.5 },
    { sort: "unknown" },
    { sort: "impressions", brandId: null },
    { limit: 20 },
  ])("rejects authenticated nonnormalized query %j", (query) => {
    expectInvalid(seal({ ...state(), query: { ...input.query, ...query } }));
  });

  it.each([
    "",
    "0:0:",
    "0:1:",
    "1:2",
    "1:2:1,",
    "1:2:01",
    "01:2:",
    "2:1:",
    "1:3:0",
    "1:3:3",
    "1:3:1,1",
    "1:3:2,1",
    "1:18446744073709551616:",
    "1:2:1;SELECT 1",
    "1e2:200:",
  ])("rejects authenticated invalid snapshot %j", (snapshot) => {
    expectInvalid(seal({ ...state(), snapshot }));
  });

  it.each([-1, 0, 1.5, 2147483648, "1", undefined])("rejects invalid impressions rank %s", (rank) => {
    expectInvalid(
      seal({
        ...state(),
        query: { ...input.query, sort: "impressions", brandId: 12 },
        position: { rank, id: "ad" },
      }),
    );
  });

  it("accepts empty/default filters, Unicode code-point bounds and calendar limits", () => {
    for (const date of ["0001-01-01", "2000-02-29", "9999-12-31"]) {
      const payload = {
        ...state(),
        snapshot: "18446744073709551615:18446744073709551615:",
        query: { ...input.query, q: "😀".repeat(500), niche: [], format: null, status: null, startedAfter: date },
      };
      expect(codec().decode(seal(payload))).toEqual(payload);
    }
  });

  it("accepts exactly 4096 ASCII output characters and explicitly refuses overflow", () => {
    const base = { ...state(), position: { startDate: "2026-01-01", id: "" } };
    const idLength = 3043 - Buffer.byteLength(JSON.stringify(base));
    const payload = { ...base, position: { ...base.position, id: "x".repeat(idLength) } };
    const token = codec().encode(payload);
    expect(token).toHaveLength(4096);
    expect(codec().decode(token)).toEqual(payload);
    expect(() =>
      codec().encode({ ...payload, position: { ...payload.position, id: `${payload.position.id}x` } }),
    ).toThrow("Server cursor state exceeds supported size");
    const snapshot = `1:1001:${Array.from({ length: 1000 }, (_, i) => String(i + 1)).join(",")}`;
    expect(() => codec().issue({ ...input, snapshot })).toThrow("Server cursor state exceeds supported size");
  });

  it("refuses invalid server-generated state instead of silently normalizing it", () => {
    expect(() => codec().issue({ ...input, query: { ...input.query, niche: ["skincare", "skincare"] } })).toThrow(
      "Invalid server cursor state",
    );
  });

  it.each(["", "short", `${"x".repeat(32)}\n`])("rejects invalid codec secret", (secret) => {
    expect(() => createCursorCodec({ secret })).toThrow("Invalid CURSOR_SECRET");
  });

  it("rejects wrong secrets actionably without exposing crypto diagnostics", () => {
    const rotated = createCursorCodec({ secret: "different-test-only-cursor-secret-123456", now: () => firstPageTime });
    expect(() => rotated.decode(codec().issue(input))).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR", message: expect.stringContaining("fresh search") }),
    );
  });
});
