import { type ErrorRequestHandler, type RequestHandler, Router } from "express";

import type { KeyHandler, KeyResponse } from "../../api-keys/index.js";
import type { Database } from "../../db/client.js";
import { sendRateLimited } from "../../shared/http-errors.js";
import { disableCaching } from "../../shared/middleware/disable-caching.js";
import { admitApiKey, billingBinding, checkBillingBinding, settleBilling } from "../../usage/index.js";
import { parseAdParameters } from "./parameters.js";
import { queryAds } from "./query.js";

const invalid: RequestHandler = (_req, res) => {
  res.status(400).json({ error: "Invalid request" });
};

function authenticate(db: Database): KeyHandler {
  return async (req, res: KeyResponse, next) => {
    const query = new URL(req.originalUrl, "http://localhost").searchParams;
    const credentials = query.getAll("api_key");
    const admission = credentials.length === 1 ? await admitApiKey(db, credentials[0]) : null;
    if (!admission) {
      invalid(req, res, next);
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

function createGetAdsHandler(db: Database): KeyHandler {
  return async function handleGetAds(req, res: KeyResponse, next) {
    if (req.method !== "GET") {
      next();
      return;
    }
    const parameters = parseAdParameters(new URL(req.originalUrl, "http://localhost").searchParams);
    if (!res.locals.apiKey.scopes.includes("search:read") || !parameters) {
      invalid(req, res, next);
      return;
    }
    const binding = billingBinding(req.rawHeaders, { operation: "v0.search", parameters });
    await checkBillingBinding(db, res.locals.apiKey, binding);
    const body = JSON.stringify(await queryAds(db, parameters));
    await settleBilling(db, res.locals.apiKey, binding);
    res.type("json").send(body);
  };
}

const handleErrors: ErrorRequestHandler = (_error: unknown, _req, res, _next) => {
  // Raw errors and request URLs can contain credentials. All non-rate failures stay local/generic.
  res.status(400).json({ error: "Invalid request" });
};

export function createRouter({ db }: { db: Database }) {
  const router = Router();
  router.use(disableCaching);
  router.use(authenticate(db));
  router.all("/ads", createGetAdsHandler(db));
  router.use(invalid);
  router.use(handleErrors);
  return router;
}
