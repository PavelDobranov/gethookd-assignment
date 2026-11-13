import type { IncomingMessage } from "node:http";

import type { KeyResponse } from "../api-keys/index.js";
import type { Database } from "../db/client.js";
import { sendError, sendQuotaExceeded } from "../shared/http-errors.js";
import { type BillingBinding, BillingError, checkBillingBinding, settleBilling } from "./billing.js";
import { type BillableRequest, billingBinding, IdempotencyHeaderError } from "./identity.js";

/** Only call after route input/cursor validation, before executing a billable read. */
export async function prepareBilling(db: Database, req: IncomingMessage, res: KeyResponse, request: BillableRequest) {
  try {
    const binding = billingBinding(req.rawHeaders, request);
    await checkBillingBinding(db, res.locals.apiKey, binding);
    return { binding };
  } catch (error) {
    if (error instanceof IdempotencyHeaderError) {
      sendError(res, "VALIDATION_ERROR", [
        { parameter: error.parameter, reason: "invalid_header", allowed_values: [], suggestion: null },
      ]);
    } else if (error instanceof BillingError && error.code === "IDEMPOTENCY_CONFLICT") {
      sendError(res, error.code);
    } else {
      throw error;
    }
    return null;
  }
}

/** The caller has already serialized the entire success body. Never retry an unknown commit. */
export async function sendBillableResult(db: Database, res: KeyResponse, body: string, binding?: BillingBinding) {
  try {
    await settleBilling(db, res.locals.apiKey, binding);
  } catch (error) {
    if (!(error instanceof BillingError)) throw error;
    if (error.code === "QUOTA_EXCEEDED" && error.periodEnd) sendQuotaExceeded(res, error.periodEnd);
    else if (error.code === "IDEMPOTENCY_CONFLICT") sendError(res, error.code);
    else throw error;
    return;
  }
  res.type("json").send(body);
}
