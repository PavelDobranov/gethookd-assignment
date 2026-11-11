import { sql } from "drizzle-orm";
import { type RequestHandler, Router } from "express";

import type { createDatabase } from "../db/client.js";
import { disableCaching } from "../shared/middleware/disable-caching.js";

type HealthOptions = {
  db: ReturnType<typeof createDatabase>["db"];
};

function createHealthHandler(db: HealthOptions["db"]): RequestHandler {
  return async function handleHealth(_req, res) {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({
        error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." },
      });
    }
  };
}

export function createHealthRouter({ db }: HealthOptions) {
  const router = Router();
  const handleHealth = createHealthHandler(db);

  router.get("/", disableCaching, handleHealth);

  return router;
}
