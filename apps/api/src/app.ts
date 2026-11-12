import express, { type Express } from "express";

import { createAdsRouter } from "./ads/router.js";
import { createAuthRouter } from "./auth/index.js";
import type { createDatabase } from "./db/client.js";
import { createHealthRouter } from "./health/router.js";
import { handleErrors } from "./shared/middleware/handle-errors.js";

type AppDependencies = {
  db: ReturnType<typeof createDatabase>["db"];
  jwtSecret: string;
};

export function createApp({ db, jwtSecret }: AppDependencies): Express {
  const app = express();

  app.use("/api/health", createHealthRouter({ db }));

  app.use("/api/auth", createAuthRouter({ db, jwtSecret }));

  app.use("/api/v0", createAdsRouter({ db }));

  app.use(handleErrors);

  return app;
}
