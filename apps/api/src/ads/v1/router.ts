import { type RequestHandler, Router } from "express";

import type { KeyHandler, KeyResponse } from "../../api-keys/index.js";
import type { Database } from "../../db/client.js";
import { prepareBilling, sendBillableResult } from "../../usage/index.js";
import { niches } from "../model.js";
import { CursorError, type CursorState, createCursorCodec } from "./cursor.js";
import { sendError } from "./errors.js";
import { normalizeParameters, parseParameters, validateParameters } from "./parameters.js";
import { queryAds } from "./query.js";
import { getAd, mapAdSummary } from "./resources.js";
import { readFirstPage } from "./visibility.js";

export const validatePath: RequestHandler = (req, res, next) => {
  try {
    decodeURI(req.path);
  } catch {
    sendError(res, "VALIDATION_ERROR", [
      { parameter: "path", reason: "malformed_encoding", allowed_values: [], suggestion: null },
    ]);
    return;
  }
  next();
};

const handleGetNiches: RequestHandler = (req, res, next) => {
  // Express normally falls back from HEAD to GET; only GET is part of this contract.
  if (req.method !== "GET") {
    next();
    return;
  }
  const queryStart = req.originalUrl.indexOf("?");
  const parameters = new URLSearchParams(queryStart === -1 ? "" : req.originalUrl.slice(queryStart + 1));
  if (parameters.size > 0) {
    sendError(res, "VALIDATION_ERROR", [
      { parameter: "query", reason: "unknown_parameter", allowed_values: [], suggestion: null },
    ]);
    return;
  }
  res.json({ data: niches.map(({ slug, name }) => ({ slug, name })) });
};

function createGetAdHandler(db: Database): KeyHandler<{ id: string }> {
  return async function handleGetAd(req, res: KeyResponse, next) {
    if (req.method !== "GET") {
      next();
      return;
    }
    const queryStart = req.originalUrl.indexOf("?");
    const parameters = new URLSearchParams(queryStart === -1 ? "" : req.originalUrl.slice(queryStart + 1));
    if (parameters.size > 0) {
      sendError(res, "VALIDATION_ERROR", [
        { parameter: "query", reason: "unknown_parameter", allowed_values: [], suggestion: null },
      ]);
      return;
    }
    // PostgreSQL text cannot represent NUL; reject it as input, not a server failure.
    if (req.params.id.includes("\0")) {
      sendError(res, "VALIDATION_ERROR", [
        { parameter: "id", reason: "invalid_text", allowed_values: [], suggestion: null },
      ]);
      return;
    }
    const billing = await prepareBilling(db, req, res, { operation: "v1.detail", id: req.params.id });
    if (!billing) return;
    const ad = await getAd(db, req.params.id);
    if (!ad) {
      sendError(res, "AD_NOT_FOUND");
      return;
    }
    const body = JSON.stringify({ data: ad });
    await sendBillableResult(db, res, body, billing.binding);
  };
}

function createSearchHandler(db: Database, cursorSecret: string): KeyHandler {
  const codec = createCursorCodec({ secret: cursorSecret, now: () => Date.now() });
  return async function handleSearch(req, res: KeyResponse, next) {
    if (req.method !== "GET") {
      next();
      return;
    }
    const now = new Date();
    const queryStart = req.originalUrl.indexOf("?");
    const parsed = parseParameters(new URLSearchParams(queryStart === -1 ? "" : req.originalUrl.slice(queryStart + 1)));
    if (parsed.error) {
      sendError(res, parsed.error.code, parsed.error.details);
      return;
    }
    const validated = validateParameters(parsed.value);
    if (validated.error) {
      sendError(res, validated.error.code, validated.error.details);
      return;
    }
    let original: CursorState | undefined;
    try {
      original = validated.value.cursor === undefined ? undefined : await codec.decode(validated.value.cursor);
    } catch (error) {
      if (!(error instanceof CursorError)) throw error;
      sendError(res, error.code);
      return;
    }
    const normalized = normalizeParameters(validated.value, original?.query);
    if (normalized.error) {
      sendError(res, normalized.error.code, normalized.error.details);
      return;
    }
    const { query, limit } = normalized.value;
    const billing = await prepareBilling(db, req, res, {
      operation: "v1.search",
      parameters: { query, limit, cursor: validated.value.cursor },
    });
    if (!billing) return;
    const page = original
      ? { snapshot: original.snapshot, data: await queryAds(db, query, limit, original) }
      : await readFirstPage(db, (tx) => queryAds(tx, query, limit));
    const rows = page.data.slice(0, limit);
    const last = rows.at(-1);
    const issuedAt = original?.issuedAt ?? now.getTime();
    const expiresAt = original?.expiresAt ?? issuedAt + 30 * 60 * 1000;
    const nextCursor =
      page.data.length > limit && last
        ? await codec.encode({
            query,
            snapshot: page.snapshot,
            issuedAt,
            expiresAt,
            position:
              query.sort === "newest"
                ? { startDate: last.startDate, id: last.id }
                : { rank: last.impressionRank, id: last.id },
          })
        : null;
    const body = JSON.stringify({
      data: rows.map((row) => mapAdSummary(row, now)),
      applied_filters: {
        q: query.q,
        niche: query.niche,
        format: query.format,
        status: query.status,
        started_after: query.startedAfter,
        brand_id: query.brandId,
      },
      sort: query.sort,
      limit,
      next_cursor: nextCursor,
      cursor_expires_at: new Date(expiresAt).toISOString(),
    });
    await sendBillableResult(db, res, body, billing.binding);
  };
}

export function createRouter({ db, cursorSecret }: { db: Database; cursorSecret: string }) {
  const router = Router();

  // Register all methods so Express cannot synthesize an OPTIONS success when
  // leaving this child router; handlers pass non-GET requests to the root fallback.
  router.all("/niches", handleGetNiches);
  router.all("/ads", createSearchHandler(db, cursorSecret));
  router.all("/ads/:id", createGetAdHandler(db));

  return router;
}
