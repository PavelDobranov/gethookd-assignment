import { type RequestHandler, Router } from "express";

import { validateApiKey } from "../api-keys/index.js";
import type { createDatabase } from "../db/client.js";
import { disableCaching } from "../shared/middleware/disable-caching.js";
import { niches } from "./model.js";
import { handleV1Errors, sendV1Error } from "./v1-errors.js";

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

const handleNotFound: RequestHandler = (_req, res) => {
  sendV1Error(res, "NOT_FOUND");
};

export function createV1Router({ db }: { db: ReturnType<typeof createDatabase>["db"]; cursorSecret: string }) {
  const router = Router();

  router.use(disableCaching);
  router.use(createAuthenticateHandler(db));
  router.use(validatePath);
  router.get("/niches", handleGetNiches);
  router.use(handleNotFound);
  router.use(handleV1Errors);

  return router;
}
