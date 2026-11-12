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

const handleGetNiches: RequestHandler = (_req, res) => {
  res.json({ data: niches.map(({ slug, name }) => ({ slug, name })) });
};

export function createV1Router({ db }: { db: ReturnType<typeof createDatabase>["db"] }) {
  const router = Router();

  router.use(disableCaching);
  router.use(createAuthenticateHandler(db));
  router.get("/niches", handleGetNiches);
  router.use(handleV1Errors);

  return router;
}
