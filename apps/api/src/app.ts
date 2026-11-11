import express, { type Express } from "express";
import { type AuthOptions, createAuthRouter } from "./auth/routes.js";

export function createApp(auth: AuthOptions): Express {
  const app = express();

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", createAuthRouter(auth));

  return app;
}
