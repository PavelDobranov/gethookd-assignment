import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { type Ad, adFormats, adStatuses, niches } from "./model.js";

export type CursorQuery = {
  q: string;
  niche: Ad["niche"][];
  format: Ad["format"] | null;
  status: "active" | "inactive" | null;
  startedAfter: string | null;
  brandId: number | null;
  sort: "newest" | "impressions";
};

export type CursorInput = {
  query: CursorQuery;
  snapshot: string;
  position: { startDate: string; id: string } | { rank: number | null; id: string };
};

export type CursorState = CursorInput & { issuedAt: number; expiresAt: number };

// No registry or process-local state: rebuilding with the same secret preserves walks.
export function createCursorCodec({ secret, now = Date.now }: { secret: string; now?: () => number }) {
  if (!secret.trim() || /\p{Cc}/u.test(secret) || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Invalid CURSOR_SECRET");
  }
  const key = createHash("sha256").update("gethookd:ads:cursor:key:v1\0").update(secret, "utf8").digest();

  function encode(state: CursorState): string {
    if (!validState(state)) throw new Error("Invalid server cursor state");
    const plaintext = Buffer.from(JSON.stringify(state));
    // One version byte + 12 nonce bytes + 16 tag bytes, encoded without padding.
    if (Math.ceil(((29 + plaintext.length) * 4) / 3) > maxTokenLength) {
      throw new Error("Server cursor state exceeds supported size");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([version]), nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
  }

  function decode(token: string): CursorState {
    let state: unknown;
    try {
      if (typeof token !== "string" || token.length > maxTokenLength || !/^[A-Za-z0-9_-]+$/.test(token))
        throw new Error();
      const envelope = Buffer.from(token, "base64url");
      if (envelope.toString("base64url") !== token || envelope.length <= 29 || envelope[0] !== version)
        throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(1, 13), { authTagLength: 16 });
      decipher.setAAD(context);
      decipher.setAuthTag(envelope.subarray(-16));
      // Do not parse or inspect any plaintext until final() has authenticated it.
      const plaintext = Buffer.concat([decipher.update(envelope.subarray(13, -16)), decipher.final()]);
      state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      if (!validState(state)) throw new Error();
    } catch {
      throw new CursorError("INVALID_CURSOR");
    }
    if (now() >= state.expiresAt) throw new CursorError("CURSOR_EXPIRED");
    return state;
  }

  function issue(input: CursorInput): string {
    const issuedAt = now();
    return encode({ ...input, issuedAt, expiresAt: issuedAt + lifetime });
  }

  return { issue, encode, decode };
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

const lifetime = 30 * 60 * 1000;
const maxTokenLength = 4096;
const version = 1;
const context = Buffer.from("gethookd:ads:cursor:v1");
const maxXid = 18446744073709551615n;

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function validSnapshot(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(value)) return false;
  const [minText, maxText, activeText] = value.split(":");
  const xid = (text: string) => /^[1-9][0-9]{0,19}$/.test(text) && BigInt(text) <= maxXid;
  if (!xid(minText) || !xid(maxText)) return false;
  const min = BigInt(minText);
  const max = BigInt(maxText);
  if (min > max) return false;
  let previous = min - 1n;
  for (const text of activeText ? activeText.split(",") : []) {
    if (!xid(text)) return false;
    const current = BigInt(text);
    if (current < min || current >= max || current <= previous) return false;
    previous = current;
  }
  return true;
}

function validQuery(value: unknown): value is CursorQuery {
  if (!hasKeys(value, ["q", "niche", "format", "status", "startedAfter", "brandId", "sort"])) return false;
  return (
    typeof value.q === "string" &&
    value.q === value.q.trim() &&
    [...value.q].length <= 500 &&
    Array.isArray(value.niche) &&
    value.niche.every(
      (slug, index, slugs) => niches.some((entry) => entry.slug === slug) && (index === 0 || slugs[index - 1] < slug),
    ) &&
    (value.format === null || adFormats.some((format) => format === value.format)) &&
    (value.status === null || adStatuses.some((status) => status === value.status)) &&
    (value.startedAfter === null || calendarDate(value.startedAfter)) &&
    (value.brandId === null || positiveInteger(value.brandId)) &&
    (value.sort === "newest" || (value.sort === "impressions" && value.brandId !== null))
  );
}

function validState(value: unknown): value is CursorState {
  if (
    !hasKeys(value, ["query", "snapshot", "position", "issuedAt", "expiresAt"]) ||
    !validQuery(value.query) ||
    !validSnapshot(value.snapshot) ||
    typeof value.issuedAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < 0 ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt > 8640000000000000 ||
    value.expiresAt - value.issuedAt !== lifetime
  )
    return false;
  const position = value.position;
  const keys = value.query.sort === "newest" ? ["startDate", "id"] : ["rank", "id"];
  if (
    !hasKeys(position, keys) ||
    typeof position.id !== "string" ||
    !position.id ||
    position.id.includes("\0") ||
    // A PostgreSQL text ID must survive UTF-8 encoding without replacement.
    Buffer.from(position.id, "utf8").toString("utf8") !== position.id
  )
    return false;
  return value.query.sort === "newest"
    ? calendarDate(position.startDate)
    : position.rank === null || positiveInteger(position.rank);
}
