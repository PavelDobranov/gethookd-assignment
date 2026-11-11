import { sql } from "drizzle-orm";
import express, { type Express } from "express";
import { type AuthOptions, createAuthRouter } from "./auth/routes.js";

export function createApp(auth: AuthOptions): Express {
  const app = express();

  app.get("/api/health", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await auth.db.execute(sql`SELECT 1`);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({
        error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." },
      });
    }
  });

  app.use("/api/auth", createAuthRouter(auth));

  return app;
}
