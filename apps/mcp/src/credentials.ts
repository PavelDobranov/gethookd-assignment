import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The outcome of inspecting one HTTP request for a usable caller Bearer
 * credential. `ok` carries the single Authorization header value to forward to
 * REST unchanged; otherwise `reason` explains why no credential is usable.
 */
export type CredentialResult =
  | { readonly ok: true; readonly authorization: string }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "ambiguous" };

// Mirror REST's own admission (apps/api api-keys middleware): exactly one
// Authorization header carrying `Bearer <token>` with this token alphabet. MCP
// forwards the same credential REST would accept, so the two agree per request.
const bearer = /^Bearer [A-Za-z0-9._~+/-]+=*$/i;

/**
 * Determines the usable caller credential from Node's `rawHeaders`, before the
 * SDK normalizes duplicate headers into a single joined value. Duplicate
 * Authorization headers are ambiguous and rejected rather than guessed; a
 * malformed single header yields safe authentication guidance. The accepted
 * header value is forwarded unchanged.
 */
export function extractCredential(rawHeaders: readonly string[]): CredentialResult {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === "authorization") values.push(rawHeaders[i + 1]);
  }
  if (values.length !== 1) {
    return { ok: false, reason: values.length === 0 ? "missing" : "ambiguous" };
  }
  const authorization = values[0];
  if (!bearer.test(authorization)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, authorization };
}

// Request-scoped credential. AsyncLocalStorage keeps each request's credential
// isolated across concurrent exchanges, so parallel callers cannot
// cross-contaminate, and nothing is ever stored globally.
const credentialStore = new AsyncLocalStorage<CredentialResult>();

/** Runs `fn` with `credential` bound to the current request's async context. */
export function runWithCredential<T>(credential: CredentialResult, fn: () => T): T {
  return credentialStore.run(credential, fn);
}

/** The current request's credential; absent context is treated as missing. */
export function currentCredential(): CredentialResult {
  return credentialStore.getStore() ?? { ok: false, reason: "missing" };
}
