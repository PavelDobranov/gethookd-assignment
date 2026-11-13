import { createHash } from "node:crypto";
import { EncryptJWT, type JWTPayload, jwtDecrypt } from "jose";
import { z } from "zod";

import { adFormats, adStatuses, niches } from "../model.js";

// Shape + cheap enum checks only. Domain validity (dates, snapshot grammar) is guaranteed by
// the server that built the payload; zod exists here to give decode a real type, not a cast.
const positiveInt = z.number().int().positive().max(2147483647);

const cursorQuery = z.object({
  q: z.string(),
  niche: z.array(z.enum(niches.map((n) => n.slug))),
  format: z.enum(adFormats).nullable(),
  status: z.enum(adStatuses).nullable(),
  startedAfter: z.string().nullable(),
  brandId: positiveInt.nullable(),
  sort: z.enum(["newest", "impressions"]),
});

const cursorState = z.object({
  query: cursorQuery,
  snapshot: z.string(),
  position: z.union([
    z.object({ startDate: z.string(), id: z.string() }),
    z.object({ rank: positiveInt.nullable(), id: z.string() }),
  ]),
  issuedAt: z.number(),
  expiresAt: z.number(),
});

export type CursorQuery = z.infer<typeof cursorQuery>;
export type CursorState = z.infer<typeof cursorState>;

// No registry or process-local state: rebuilding with the same secret resumes any walk.
// Authenticated encryption under a server-only key ⇒ decrypted contents are trusted as
// server-issued; untrusted input is validated by v1/parameters.ts, not here.
export function createCursorCodec({ secret, now = Date.now }: { secret: string; now?: () => number }) {
  if (Buffer.byteLength(secret.trim(), "utf8") < 32) throw new Error("Invalid CURSOR_SECRET");
  const key = createHash("sha256").update("gethookd:ads:cursor:v1\0").update(secret, "utf8").digest();

  async function encode(state: CursorState): Promise<string> {
    // jose's JWTPayload needs an index-signature type, hence this single unavoidable cast.
    return (
      new EncryptJWT({ ...state } as unknown as JWTPayload)
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setAudience(audience)
        // issuedAt/expiresAt ride as exact ms claims so cursor_expires_at stays identical and
        // the lifetime stays millisecond-precise across pages. jose's second-granularity exp is
        // only a coarse backstop, so round it up — it must never fire before the true ms expiry.
        .setExpirationTime(Math.ceil(state.expiresAt / 1000))
        .encrypt(key)
    );
  }

  async function decode(token: string): Promise<CursorState> {
    let state: CursorState;
    try {
      const { payload } = await jwtDecrypt(token, key, { audience, currentDate: new Date(now()) });
      state = cursorState.parse(payload); // real CursorState, no cast; shape mismatch → caught below
    } catch (error) {
      if (error != null && typeof error === "object" && "code" in error && error.code === "ERR_JWT_EXPIRED") {
        throw new CursorError("CURSOR_EXPIRED");
      }
      throw new CursorError("INVALID_CURSOR");
    }
    // Authoritative, millisecond-precise expiry from the exact claim; jose's exp is the backstop.
    if (now() >= state.expiresAt) throw new CursorError("CURSOR_EXPIRED");
    return state;
  }

  return { encode, decode };
}

export class CursorError extends Error {
  constructor(readonly code: "INVALID_CURSOR" | "CURSOR_EXPIRED") {
    super(
      code === "CURSOR_EXPIRED"
        ? "Cursor expired; start a fresh search."
        : "Invalid cursor; use an unmodified supported token or start a fresh search.",
    );
    this.name = "CursorError";
  }
}

// Versioned audience = format-skew guard: bump to :v2 on any payload change and old tokens
// fail cleanly as INVALID_CURSOR. Also replaces the old AAD/context binding.
const audience = "gethookd:ads:cursor:v1";
