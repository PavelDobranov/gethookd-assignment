import { createHash } from "node:crypto";
import { EncryptJWT, type JWTPayload } from "jose";
import { describe, expect, it } from "vitest";

import { type CursorState, createCursorCodec } from "../src/ads/v1/cursor.js";

const secret = "test-only-independent-cursor-secret-123456";
const firstPageTime = Date.parse("2026-10-03T12:00:00.000Z");
const lifetime = 30 * 60 * 1000;
const audience = "gethookd:ads:cursor:v1";

const state: CursorState = {
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
  issuedAt: firstPageTime,
  expiresAt: firstPageTime + lifetime,
};

function codec(now = firstPageTime) {
  return createCursorCodec({ secret, now: () => now });
}

// Seal an arbitrary payload under the real key, exactly as the server encodes, to drive
// decode's post-decryption shape checks. Audience and expiry default to valid so a shape
// mismatch is what decode rejects — not the envelope, audience or expiry.
function seal(payload: unknown, { aud = audience, exp = Math.floor(state.expiresAt / 1000) } = {}) {
  const key = createHash("sha256").update("gethookd:ads:cursor:v1\0").update(secret, "utf8").digest();
  return new EncryptJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(aud)
    .setExpirationTime(exp)
    .encrypt(key);
}

async function expectInvalid(token: string, now = firstPageTime) {
  await expect(codec(now).decode(token)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
}

describe("v1 stateless cursor", () => {
  it("round trips newest with string snapshot IDs and opaque text ad IDs", async () => {
    const token = await codec().encode(state);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(await codec().decode(token)).toEqual(state);
  });

  it.each([1, 2147483647, null])("round trips impressions position %s", async (rank) => {
    const impressions = {
      ...state,
      query: { ...state.query, sort: "impressions", brandId: 12 },
      position: { rank, id: "ad-null-or-known" },
    } satisfies CursorState;
    expect(await codec().decode(await codec().encode(impressions))).toEqual(impressions);
  });

  it("reconstructs statelessly: a fresh codec with the same secret decodes another's token", async () => {
    const producer = createCursorCodec({ secret, now: () => firstPageTime });
    const consumer = createCursorCodec({ secret, now: () => firstPageTime });
    expect(await consumer.decode(await producer.encode(state))).toEqual(state);
  });

  it("preserves the exact millisecond expiry just before the lifetime ends, then expires", async () => {
    // encode stamps the lifetime from state.expiresAt, independent of the continuation clock.
    const token = await codec(firstPageTime + lifetime - 1).encode(state);
    expect((await codec(firstPageTime + lifetime - 1).decode(token)).expiresAt).toBe(state.expiresAt);
    await expect(codec(firstPageTime + lifetime).decode(token)).rejects.toMatchObject({
      code: "CURSOR_EXPIRED",
      message: expect.stringContaining("fresh search"),
    });
  });

  it("rejects tampering with any segment of the compact token", async () => {
    // Flip the leading character of each non-empty segment: that character's six bits are all
    // significant bits of byte 0, so every segment's decoded bytes genuinely change. (The final
    // character of a segment carries unused padding bits, so flipping it can alias to the same
    // bytes and legitimately still verify — that is not tampering.)
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    const segments = (await codec().encode(state)).split("."); // header.encryptedKey.iv.ciphertext.tag
    for (let s = 0; s < segments.length; s++) {
      const segment = segments[s] ?? "";
      if (segment === "") continue; // "dir" leaves the encrypted-key segment empty
      const flipped = [...segments];
      flipped[s] = alphabet[(alphabet.indexOf(segment[0] ?? "") + 1) % alphabet.length] + segment.slice(1);
      await expectInvalid(flipped.join("."));
    }
  });

  it("rejects a token sealed with a different secret, without crypto diagnostics", async () => {
    const rotated = createCursorCodec({ secret: "different-test-only-cursor-secret-123456", now: () => firstPageTime });
    await expect(rotated.decode(await codec().encode(state))).rejects.toMatchObject({
      code: "INVALID_CURSOR",
      message: expect.stringContaining("fresh search"),
    });
  });

  it("rejects a token issued for a different audience", async () => {
    await expectInvalid(await seal(state, { aud: "other-feature:v1" }));
  });

  it.each(["", " ", "not-a-jwe", "a.b.c", "a.b.c.d.e", "💥"])("rejects malformed token %j", async (token) => {
    await expectInvalid(token);
  });

  it.each([
    {},
    { ...state, snapshot: null },
    { ...state, position: { rank: 1 } },
    { ...state, position: { startDate: "2026-01-01" } },
    { ...state, issuedAt: "2026-10-03T12:00:00Z" },
    { ...state, query: { ...state.query, niche: ["not-a-niche"] } },
    { ...state, query: { ...state.query, sort: "unknown" } },
  ])("rejects a well-encrypted but wrong-shaped payload %j", async (payload) => {
    await expectInvalid(await seal(payload));
  });

  it.each(["", "short"])("rejects an under-length codec secret %j", (secret) => {
    expect(() => createCursorCodec({ secret })).toThrow("Invalid CURSOR_SECRET");
  });
});
