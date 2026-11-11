import express, { type Express } from "express";

import { type AuthOptions, createAuthRouter } from "./auth/index.js";
import { createHealthRouter } from "./health/routes.js";
import { handleErrors } from "./shared/middleware/handle-errors.js";

export function createApp(auth: AuthOptions): Express {
  const app = express();

  app.use("/api/health", createHealthRouter({ db: auth.db }));

  app.use("/api/auth", createAuthRouter(auth));

  app.use(handleErrors);

  return app;
}
