import express, { type Express } from "express";

import { createRouter as createV0Router } from "./ads/v0/router.js";
import { handleErrors as handleV1Errors, sendError } from "./ads/v1/errors.js";
import { createRouter as createV1Router, validatePath } from "./ads/v1/router.js";
import { createRequireApiKey, requireScope } from "./api-keys/index.js";
import { createPortalKeyRouter } from "./api-keys/portal-router.js";
import { createApiKeyRouter } from "./api-keys/router.js";
import { createAuthRouter } from "./auth/index.js";
import { developmentCursorSecret } from "./config.js";
import type { Database } from "./db/client.js";
import { createHealthRouter } from "./health/router.js";
import { disableCaching } from "./shared/middleware/disable-caching.js";
import { handleErrors } from "./shared/middleware/handle-errors.js";

type AppDependencies = {
  db: Database;
  jwtSecret: string;
  cursorSecret?: string;
};

export function createApp({ db, jwtSecret, cursorSecret = developmentCursorSecret }: AppDependencies): Express {
  const app = express();

  app.use("/api/health", createHealthRouter({ db }));

  app.use("/api/auth", createAuthRouter({ db, jwtSecret }));

  app.use("/api/portal", createPortalKeyRouter({ db, jwtSecret }));

  app.use("/api/v0", createV0Router({ db }));

  const v1 = express.Router();
  v1.use(disableCaching);
  v1.use(createRequireApiKey(db));
  v1.use(["/ads", "/niches"], requireScope("search:read"));
  v1.use(["/keys", "/usage"], requireScope("keys:manage"));
  v1.use(validatePath);
  v1.use(createV1Router({ db, cursorSecret }));
  v1.use(createApiKeyRouter({ db }));
  v1.use((_req, res) => sendError(res, "NOT_FOUND"));
  v1.use(handleV1Errors);
  app.use("/api/v1", v1);

  app.use(handleErrors);

  return app;
}
