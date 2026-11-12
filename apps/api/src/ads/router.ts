import { type RequestHandler, Router } from "express";

import { validateApiKey } from "../api-keys/index.js";
import type { createDatabase } from "../db/client.js";
import { disableCaching } from "../shared/middleware/disable-caching.js";
import { parseAdParameters } from "./parameters.js";
import { queryAds } from "./query.js";

function createGetAdsHandler(db: ReturnType<typeof createDatabase>["db"]): RequestHandler {
  return async function handleGetAds(req, res) {
    try {
      const parameters = parseAdParameters(new URL(req.originalUrl, "http://localhost").searchParams);

      if (!parameters || !(await validateApiKey(db, parameters.apiKey))) {
        res.status(400).json({ error: "Invalid request" });
        return;
      }

      res.json(await queryAds(db, parameters));
    } catch {
      // Keep legacy failures local; raw errors and request URLs can contain keys.
      res.status(400).json({ error: "Invalid request" });
    }
  };
}

export function createAdsRouter({ db }: { db: ReturnType<typeof createDatabase>["db"] }) {
  const router = Router();
  const handleGetAds = createGetAdsHandler(db);

  router.use(disableCaching);
  router.get("/ads", handleGetAds);

  return router;
}
