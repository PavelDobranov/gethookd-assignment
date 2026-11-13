import { type ErrorRequestHandler, json, type RequestHandler, type Response, Router } from "express";

import type { Database } from "../db/client.js";
import { sendError } from "../shared/http-errors.js";
import { readUsage } from "../usage/index.js";
import { createApiKey, type KeyAuthority, KeyLifecycleError, listApiKeys, revokeApiKey } from "./lifecycle.js";
import type { KeyHandler } from "./middleware.js";

type Dependencies = { db: Database };
export type ManagementLocals = { authority: KeyAuthority };
type Locals = ManagementLocals;
type Handler = RequestHandler<Record<string, string>, unknown, unknown, Record<string, unknown>, Locals>;

function invalid(res: Response, parameter: string, reason: string) {
  sendError(res, "VALIDATION_ERROR", [{ parameter, reason, allowed_values: [], suggestion: null }]);
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
    const result = await createApiKey(db, res.locals.authority, body.scopes);
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
    res.json(await listApiKeys(db, res.locals.authority, pagination));
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
    const key = await revokeApiKey(db, res.locals.authority, id);
    if (!key) {
      sendError(res, "KEY_NOT_FOUND");
      return;
    }
    res.status(204).end();
  };
}

function usage(db: Dependencies["db"]): Handler {
  return async function getUsage(req, res) {
    if (Object.keys(req.query).length) {
      invalid(res, "query", "unknown_parameter");
      return;
    }
    const authority = res.locals.authority;
    const ownerId = authority.kind === "user" ? authority.userId : authority.identity.userId;
    res.json(await readUsage(db, ownerId));
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

const apiAuthority: KeyHandler = (_req, res, next) => {
  const locals: ManagementLocals = { authority: { kind: "api-key", identity: res.locals.apiKey } };
  Object.assign(res.locals, locals);
  next();
};

/** Mounted after the shared v1 authentication/admission and management scope check. */
export function createApiKeyRouter({ db }: Dependencies) {
  const router = Router();
  router.use(apiAuthority);
  router.use(createManagementRouter({ db }));
  return router;
}

function onlyMethod(method: string, handler: Handler): Handler {
  return (req, res, next) => {
    if (req.method === method) return handler(req, res, next);
    next();
  };
}

/** Both credential boundaries provide a trusted authority before mounting these free operations. */
export function createManagementRouter({ db }: Dependencies) {
  const router = Router();
  router.use(json({ limit: "16kb", strict: false }));
  router.use(handleBodyErrors);
  router.all("/keys", onlyMethod("POST", createKey(db)), onlyMethod("GET", listKeys(db)));
  router.all("/keys/:id", onlyMethod("DELETE", revokeKey(db)));
  router.all("/usage", onlyMethod("GET", usage(db)));
  router.use(notFound);
  router.use(handlePortalErrors);
  return router;
}
