import { type ErrorRequestHandler, type RequestHandler, Router } from "express";

import { createAuthService } from "../auth/index.js";
import type { Database } from "../db/client.js";
import { sendError } from "../shared/http-errors.js";
import { createManagementRouter, type ManagementLocals } from "./router.js";

type Dependencies = { db: Database; jwtSecret: string };

function authenticate(auth: ReturnType<typeof createAuthService>): RequestHandler {
  return async function authenticatePortal(req, res, next) {
    const token = /^Bearer (\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
    const user = token ? await auth.getUser(token) : null;
    if (!user) {
      sendError(res, "UNAUTHENTICATED");
      return;
    }
    const locals: ManagementLocals = { authority: { kind: "user", userId: user.id } };
    Object.assign(res.locals, locals);
    next();
  };
}
const handleErrors: ErrorRequestHandler = (_error: unknown, _req, res, _next) => {
  sendError(res, "INTERNAL_ERROR");
};

export function createPortalKeyRouter({ db, jwtSecret }: Dependencies) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(authenticate(createAuthService(db, jwtSecret)));
  router.use(createManagementRouter({ db }));
  router.use(handleErrors);
  return router;
}
