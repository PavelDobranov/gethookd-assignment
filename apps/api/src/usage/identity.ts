import { createHash } from "node:crypto";

import type { AdParameters, CursorQuery } from "../ads/index.js";
import type { BillingBinding } from "./billing.js";

/** Only already-effective parser outputs; never pass a raw URL or a generated response cursor. */
export type BillableRequest =
  | { operation: "v0.search"; parameters: AdParameters }
  | { operation: "v1.search"; parameters: { query: CursorQuery; limit: number; cursor: string | undefined } }
  | { operation: "v1.detail"; id: string };

export class IdempotencyHeaderError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly parameter = "Idempotency-Key";

  constructor() {
    super("Invalid Idempotency-Key.");
    this.name = "IdempotencyHeaderError";
  }
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Use IncomingMessage.rawHeaders: merged headers hide duplicate occurrences. Returns only a hash. */
export function parseIdempotencyKeyHash(rawHeaders: readonly string[]): string | undefined {
  let valueHash: string | undefined;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== "idempotency-key") continue;
    if (valueHash !== undefined) throw new IdempotencyHeaderError();
    // Only HTTP optional whitespace; no Unicode trimming or opaque-value normalization.
    const value = rawHeaders[i + 1].replace(/^[ \t]+|[ \t]+$/g, "");
    if (value.length < 1 || value.length > 128 || /[^A-Za-z0-9._:-]/.test(value)) {
      throw new IdempotencyHeaderError();
    }
    valueHash = hash(value);
  }
  return valueHash;
}

/** Fixed-position JSON tuples avoid property-order dependence and delimiter ambiguity. */
export function fingerprintRequest(request: BillableRequest): string {
  switch (request.operation) {
    case "v0.search": {
      const p = request.parameters;
      // Deliberate allowlist: p.apiKey and all ignored/transport values are excluded.
      return hash(
        JSON.stringify([
          "GET",
          request.operation,
          p.q,
          p.niche ?? null,
          p.format ?? null,
          p.status ?? null,
          p.page,
          p.perPage,
        ]),
      );
    }
    case "v1.search": {
      const { query: q, limit, cursor } = request.parameters;
      return hash(
        JSON.stringify([
          "GET",
          request.operation,
          q.q,
          q.niche,
          q.format,
          q.status,
          q.startedAfter,
          q.brandId,
          q.sort,
          limit,
          cursor ?? null,
        ]),
      );
    }
    case "v1.detail":
      // Express already decoded this ID once; do not trim, case-fold or decode again.
      return hash(JSON.stringify(["GET", request.operation, request.id]));
  }
}

/** Call only for billable operations. Free routes must not validate or bind this header. */
export function billingBinding(rawHeaders: readonly string[], request: BillableRequest): BillingBinding | undefined {
  const valueHash = parseIdempotencyKeyHash(rawHeaders);
  return valueHash === undefined ? undefined : { valueHash, fingerprintHash: fingerprintRequest(request) };
}
