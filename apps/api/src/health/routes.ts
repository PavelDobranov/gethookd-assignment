import { sql } from "drizzle-orm";
import { Router } from "express";

import type { createDatabase } from "../db/client.js";
import { disableCaching } from "../shared/middleware/disable-caching.js";

type HealthOptions = {
  db: ReturnType<typeof createDatabase>["db"];
};

export function createHealthRouter({ db }: HealthOptions) {
  const router = Router();

  router.get("/", disableCaching, async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({
        error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." },
      });
    }
  });

  return router;
}
