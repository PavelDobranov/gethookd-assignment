import { type RequestHandler, Router } from "express";

import { validateApiKey } from "../api-keys/index.js";
import type { createDatabase } from "../db/client.js";
import { disableCaching } from "../shared/middleware/disable-caching.js";
import { CursorError, type CursorState, createCursorCodec } from "./cursor.js";
import { niches } from "./model.js";
import { handleV1Errors, sendV1Error } from "./v1-errors.js";
import { normalizeV1Parameters, parseV1Parameters, validateV1Parameters } from "./v1-parameters.js";
import { queryV1Ads } from "./v1-query.js";
import { getV1Ad, mapV1AdSummary } from "./v1-resources.js";
import { readFirstPage } from "./visibility.js";

function createAuthenticateHandler(db: ReturnType<typeof createDatabase>["db"]): RequestHandler {
  return async function authenticate(req, res, next) {
    const credentials = req.rawHeaders.filter(
      (_, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === "authorization",
    );
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(req.headers.authorization ?? "");
    if (credentials.length !== 1 || !match || !(await validateApiKey(db, match[1]))) {
      sendV1Error(res, "UNAUTHENTICATED");
      return;
    }
    next();
  };
}

const validatePath: RequestHandler = (req, res, next) => {
  try {
    decodeURI(req.path);
  } catch {
    sendV1Error(res, "VALIDATION_ERROR", [
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
    sendV1Error(res, "VALIDATION_ERROR", [
      { parameter: "query", reason: "unknown_parameter", allowed_values: [], suggestion: null },
    ]);
    return;
  }
  res.json({ data: niches.map(({ slug, name }) => ({ slug, name })) });
};

function createGetAdHandler(db: ReturnType<typeof createDatabase>["db"]): RequestHandler<{ id: string }> {
  return async function handleGetAd(req, res, next) {
    if (req.method !== "GET") {
      next();
      return;
    }
    const queryStart = req.originalUrl.indexOf("?");
    const parameters = new URLSearchParams(queryStart === -1 ? "" : req.originalUrl.slice(queryStart + 1));
    if (parameters.size > 0) {
      sendV1Error(res, "VALIDATION_ERROR", [
        { parameter: "query", reason: "unknown_parameter", allowed_values: [], suggestion: null },
      ]);
      return;
    }
    // PostgreSQL text cannot represent NUL; reject it as input, not a server failure.
    if (req.params.id.includes("\0")) {
      sendV1Error(res, "VALIDATION_ERROR", [
        { parameter: "id", reason: "invalid_text", allowed_values: [], suggestion: null },
      ]);
      return;
    }
    const ad = await getV1Ad(db, req.params.id);
    if (!ad) {
      sendV1Error(res, "AD_NOT_FOUND");
      return;
    }
    res.json({ data: ad });
  };
}

function createSearchHandler(db: ReturnType<typeof createDatabase>["db"], cursorSecret: string): RequestHandler {
  const codec = createCursorCodec({ secret: cursorSecret, now: () => Date.now() });
  return async function handleSearch(req, res, next) {
    if (req.method !== "GET") {
      next();
      return;
    }
    const now = new Date();
    const queryStart = req.originalUrl.indexOf("?");
    const parsed = parseV1Parameters(
      new URLSearchParams(queryStart === -1 ? "" : req.originalUrl.slice(queryStart + 1)),
    );
    if (parsed.error) {
      sendV1Error(res, parsed.error.code, parsed.error.details);
      return;
    }
    const validated = validateV1Parameters(parsed.value);
    if (validated.error) {
      sendV1Error(res, validated.error.code, validated.error.details);
      return;
    }
    let original: CursorState | undefined;
    try {
      original = validated.value.cursor === undefined ? undefined : codec.decode(validated.value.cursor);
    } catch (error) {
      if (!(error instanceof CursorError)) throw error;
      sendV1Error(res, error.code);
      return;
    }
    const normalized = normalizeV1Parameters(validated.value, original?.query);
    if (normalized.error) {
      sendV1Error(res, normalized.error.code, normalized.error.details);
      return;
    }
    const { query, limit } = normalized.value;
    const page = original
      ? { snapshot: original.snapshot, data: await queryV1Ads(db, query, limit, original) }
      : await readFirstPage(db, (tx) => queryV1Ads(tx, query, limit));
    const rows = page.data.slice(0, limit);
    const last = rows.at(-1);
    const issuedAt = original?.issuedAt ?? now.getTime();
    const expiresAt = original?.expiresAt ?? issuedAt + 30 * 60 * 1000;
    const nextCursor =
      page.data.length > limit && last
        ? codec.encode({
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
    res.json({
      data: rows.map((row) => mapV1AdSummary(row, now)),
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
  };
}

const handleNotFound: RequestHandler = (_req, res) => {
  sendV1Error(res, "NOT_FOUND");
};

export function createV1Router({
  db,
  cursorSecret,
}: {
  db: ReturnType<typeof createDatabase>["db"];
  cursorSecret: string;
}) {
  const router = Router();

  router.use(disableCaching);
  router.use(createAuthenticateHandler(db));
  router.use(validatePath);
  router.get("/niches", handleGetNiches);
  router.get("/ads", createSearchHandler(db, cursorSecret));
  router.get("/ads/:id", createGetAdHandler(db));
  router.use(handleNotFound);
  router.use(handleV1Errors);

  return router;
}
