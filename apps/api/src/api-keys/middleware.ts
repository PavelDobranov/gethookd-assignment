import type { Request, RequestHandler, Response } from "express";

import type { createDatabase } from "../db/client.js";
import { sendError, sendHttpError, sendRateLimited } from "../shared/http-errors.js";
import { admitApiKey } from "../usage/index.js";
import type { ApiKeyIdentity } from "./keys.js";
import type { ApiKeyScope } from "./lifecycle.js";

export type KeyLocals = { apiKey: ApiKeyIdentity };
export type KeyResponse = Response<unknown, KeyLocals>;
export type KeyHandler<Params = Request["params"]> = RequestHandler<
  Params,
  unknown,
  unknown,
  Request["query"],
  KeyLocals
>;

export function createRequireApiKey(db: ReturnType<typeof createDatabase>["db"]): KeyHandler {
  return async (req, res: KeyResponse, next) => {
    const occurrences = req.rawHeaders.filter(
      (header, index) => index % 2 === 0 && header.toLowerCase() === "authorization",
    );
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(req.headers.authorization ?? "");
    const admission = occurrences.length === 1 && match ? await admitApiKey(db, match[1]) : null;
    if (!admission) {
      sendHttpError(res, "UNAUTHENTICATED", {
        status: 401,
        message: "A valid Bearer API key is required.",
        next_action: "Provide a stored API key in Authorization: Bearer <key>.",
      });
      return;
    }
    if (!admission.allowed) {
      sendRateLimited(res, admission.retryAfter);
      return;
    }
    res.locals.apiKey = admission.identity;
    next();
  };
}

export function requireScope(scope: ApiKeyScope): KeyHandler {
  return (_req, res: KeyResponse, next) => {
    if (!res.locals.apiKey.scopes.includes(scope)) {
      sendError(res, "INSUFFICIENT_SCOPE");
      return;
    }
    next();
  };
}
