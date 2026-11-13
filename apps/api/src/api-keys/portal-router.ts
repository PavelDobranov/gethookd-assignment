import { type ErrorRequestHandler, json, type RequestHandler, type Response, Router } from "express";

import { createAuthService } from "../auth/index.js";
import type { createDatabase } from "../db/client.js";
import { sendError } from "../shared/http-errors.js";
import { createApiKey, KeyLifecycleError, listApiKeys, revokeApiKey } from "./lifecycle.js";

type Dependencies = { db: ReturnType<typeof createDatabase>["db"]; jwtSecret: string };
type Locals = { ownerId: string };
type Handler = RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, Locals>;

function invalid(res: Response, parameter: string, reason: string) {
  sendError(res, "VALIDATION_ERROR", [{ parameter, reason, allowed_values: [], suggestion: null }]);
}

const noStore: RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

function authenticate(auth: ReturnType<typeof createAuthService>): Handler {
  return async function authenticatePortal(req, res, next) {
    const token = /^Bearer (\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
    const user = token ? await auth.getUser(token) : null;
    if (!user) {
      sendError(res, "UNAUTHENTICATED");
      return;
    }
    res.locals.ownerId = user.id;
    next();
  };
}

function createKey(db: Dependencies["db"]): Handler {
  return async function createPortalKey(req, res) {
    if (Object.keys(req.query).length) {
      invalid(res, "query", "unknown_parameter");
      return;
    }
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("scopes" in body)
    ) {
      invalid(res, "body", "expected_scopes_object");
      return;
    }
    const result = await createApiKey(db, { kind: "user", userId: res.locals.ownerId }, body.scopes);
    res.status(201).json(result);
  };
}

function listKeys(db: Dependencies["db"]): Handler {
  return async function listPortalKeys(req, res) {
    if (Object.keys(req.query).some((key) => key !== "limit" && key !== "offset")) {
      invalid(res, "query", "unknown_parameter");
      return;
    }
    const pagination: { limit?: number; offset?: number } = {};
    for (const parameter of ["limit", "offset"] as const) {
      const raw = req.query[parameter];
      if (raw === undefined) continue;
      if (typeof raw !== "string" || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        invalid(res, parameter, "invalid_pagination");
        return;
      }
      pagination[parameter] = Number(raw);
    }
    res.json(await listApiKeys(db, { kind: "user", userId: res.locals.ownerId }, pagination));
  };
}

function revokeKey(db: Dependencies["db"]): Handler {
  return async function revokePortalKey(req, res) {
    if (Object.keys(req.query).length) {
      invalid(res, "query", "unknown_parameter");
      return;
    }
    const id = req.params.id;
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      invalid(res, "id", "invalid_uuid");
      return;
    }
    const key = await revokeApiKey(db, { kind: "user", userId: res.locals.ownerId }, id);
    if (!key) {
      sendError(res, "KEY_NOT_FOUND");
      return;
    }
    res.status(204).end();
  };
}

const notFound: RequestHandler = (_req, res) => {
  sendError(res, "NOT_FOUND");
};
const handleBodyErrors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  // This boundary handles only JSON-parser failures, not database/operation errors.
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (status === 413) sendError(res, "BODY_TOO_LARGE");
  else if (typeof status === "number" && status >= 400 && status < 500) sendError(res, "MALFORMED_JSON");
  else next(error);
};
const handlePortalErrors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof KeyLifecycleError) {
    if (error.code === "INSUFFICIENT_SCOPE") sendError(res, "INSUFFICIENT_SCOPE");
    else invalid(res, error.code === "INVALID_SCOPES" ? "scopes" : "pagination", error.code.toLowerCase());
    return;
  }
  // Never reflect or log the body or exception.
  if (error instanceof URIError) invalid(res, "path", "malformed_path");
  else sendError(res, "INTERNAL_ERROR");
};

export function createPortalKeyRouter({ db, jwtSecret }: Dependencies) {
  const router = Router();
  router.use(noStore);
  router.use(authenticate(createAuthService(db, jwtSecret)));
  router.use(json({ limit: "16kb", strict: false }));
  router.use(handleBodyErrors);
  router.head("/keys", notFound);
  router.post("/keys", createKey(db));
  router.get("/keys", listKeys(db));
  router.delete("/keys/:id", revokeKey(db));
  router.use(notFound);
  router.use(handlePortalErrors);
  return router;
}
