import express, { type Express } from "express";

import { createRouter as createV0Router } from "./ads/v0/router.js";
import { createRouter as createV1Router } from "./ads/v1/router.js";
import { createAuthRouter } from "./auth/index.js";
import { developmentCursorSecret } from "./config.js";
import type { createDatabase } from "./db/client.js";
import { createHealthRouter } from "./health/router.js";
import { handleErrors } from "./shared/middleware/handle-errors.js";

type AppDependencies = {
  db: ReturnType<typeof createDatabase>["db"];
  jwtSecret: string;
  cursorSecret?: string;
};

export function createApp({ db, jwtSecret, cursorSecret = developmentCursorSecret }: AppDependencies): Express {
  const app = express();

  app.use("/api/health", createHealthRouter({ db }));

  app.use("/api/auth", createAuthRouter({ db, jwtSecret }));

  app.use("/api/v0", createV0Router({ db }));

  app.use("/api/v1", createV1Router({ db, cursorSecret }));

  app.use(handleErrors);

  return app;
}
