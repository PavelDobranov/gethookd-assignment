export type KeyScope = "search:read" | "keys:manage";
export interface KeyMetadata {
  id: string;
  prefix: string;
  scopes: KeyScope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
export interface KeyList {
  data: KeyMetadata[];
  limit: number;
  offset: number;
  has_more: boolean;
}
export interface CreatedKey {
  data: KeyMetadata;
  secret: string;
}
export interface OwnerUsage {
  data: { period_start: string; period_end: string; billable_calls: number; quota: number; remaining: number };
}
export type PortalErrorKind =
  | "unauthenticated"
  | "validation"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "server"
  | "network"
  | "invalid_response";
const messages: Record<PortalErrorKind, string> = {
  unauthenticated: "Log in again to use the portal.",
  validation: "Correct the request and try again.",
  forbidden: "This credential does not have permission.",
  not_found: "The key or route was not found.",
  conflict: "The request conflicts with an existing operation.",
  server: "The portal service could not complete the request.",
  network: "The portal service could not be reached.",
  invalid_response: "The portal returned an invalid response.",
};
const unknownCreation =
  " Creation may have succeeded; its secret cannot be recovered. List and revoke the orphaned key before explicitly creating another. Do not automatically retry.";

export class PortalError extends Error {
  constructor(
    public readonly kind: PortalErrorKind,
    public readonly status?: number,
    public readonly code?: string,
    public readonly creationOutcomeUnknown = false,
  ) {
    super(messages[kind] + (creationOutcomeUnknown ? unknownCreation : ""));
    this.name = "PortalError";
  }
}
function invalid(): never {
  throw new PortalError("invalid_response");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function scopes(value: unknown): value is KeyScope[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 2 &&
    new Set(value).size === value.length &&
    value.every((s) => s === "search:read" || s === "keys:manage")
  );
}
function parseKey(value: unknown): KeyMetadata {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    typeof value.prefix !== "string" ||
    value.prefix.length === 0 ||
    !scopes(value.scopes) ||
    !iso(value.created_at) ||
    !(value.last_used_at === null || iso(value.last_used_at)) ||
    !(value.revoked_at === null || iso(value.revoked_at))
  )
    invalid();
  return {
    id: value.id,
    prefix: value.prefix,
    scopes: [...value.scopes],
    created_at: value.created_at,
    last_used_at: value.last_used_at,
    revoked_at: value.revoked_at,
  };
}
function parseList(body: unknown): KeyList {
  if (
    !record(body) ||
    !Array.isArray(body.data) ||
    !integer(body.limit, 1, 100) ||
    !integer(body.offset, 0) ||
    typeof body.has_more !== "boolean" ||
    body.data.length > body.limit
  )
    invalid();
  return { data: body.data.map(parseKey), limit: body.limit, offset: body.offset, has_more: body.has_more };
}
function parseCreated(body: unknown): CreatedKey {
  if (!record(body) || typeof body.secret !== "string" || !/^ghk_[A-Za-z0-9_-]{43}$/.test(body.secret)) invalid();
  const data = parseKey(body.data);
  if (data.prefix !== body.secret.slice(0, 12)) invalid();
  return { data, secret: body.secret };
}
function parseUsage(body: unknown): OwnerUsage {
  if (!record(body) || !record(body.data)) invalid();
  const d = body.data;
  if (
    !iso(d.period_start) ||
    !iso(d.period_end) ||
    !/^\d{4}-\d{2}-01T00:00:00.000Z$/.test(d.period_start) ||
    d.quota !== 1000 ||
    !integer(d.billable_calls, 0, 1000) ||
    d.remaining !== 1000 - d.billable_calls
  )
    invalid();
  const next = new Date(d.period_start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  if (next.toISOString() !== d.period_end) invalid();
  return {
    data: {
      period_start: d.period_start,
      period_end: d.period_end,
      billable_calls: d.billable_calls,
      quota: d.quota,
      remaining: 1000 - d.billable_calls,
    },
  };
}
const errorCodes: Record<string, { status: number; kind: PortalErrorKind }> = {
  MALFORMED_JSON: { status: 400, kind: "validation" },
  INSUFFICIENT_SCOPE: { status: 403, kind: "forbidden" },
  KEY_NOT_FOUND: { status: 404, kind: "not_found" },
  NOT_FOUND: { status: 404, kind: "not_found" },
  IDEMPOTENCY_CONFLICT: { status: 409, kind: "conflict" },
  BODY_TOO_LARGE: { status: 413, kind: "validation" },
  VALIDATION_ERROR: { status: 422, kind: "validation" },
  INTERNAL_ERROR: { status: 500, kind: "server" },
};
function validDetail(value: unknown) {
  return (
    record(value) &&
    typeof value.parameter === "string" &&
    typeof value.reason === "string" &&
    Array.isArray(value.allowed_values) &&
    value.allowed_values.every((v: unknown) => typeof v === "string") &&
    (value.suggestion === null || typeof value.suggestion === "string")
  );
}
function parseError(body: unknown, status: number): PortalError {
  if (!record(body) || !record(body.error)) invalid();
  const e = body.error;
  const definition = typeof e.code === "string" && Object.hasOwn(errorCodes, e.code) ? errorCodes[e.code] : undefined;
  if (
    !definition ||
    definition.status !== status ||
    typeof e.message !== "string" ||
    typeof e.next_action !== "string" ||
    e.retryable !== (status === 500) ||
    !Array.isArray(e.details) ||
    !e.details.every(validDetail)
  )
    invalid();
  // Never expose server-controlled messages/details, which can contain sensitive input.
  return new PortalError(definition.kind, status, String(e.code));
}

// Fetch fulfills on HTTP errors; redirects/network and JSON/body failures are distinct.
// https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#handling_the_response
async function request<T>(
  token: string,
  path: string,
  method: "GET" | "POST" | "DELETE",
  status: number,
  parse: (body: unknown) => T,
  body?: string,
): Promise<T> {
  // Shape only: the live server establishes JWT authority, never decoded claims.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new PortalError("unauthenticated");
  }
  const creating = method === "POST";
  let response: Response;
  try {
    response = await fetch(`/api/portal${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    throw new PortalError("network", undefined, undefined, creating);
  }
  // A JWT 401 is authoritative even if an intermediary replaced the error body.
  if (response.status === 401) throw new PortalError("unauthenticated", 401, "UNAUTHENTICATED");
  try {
    if (!response.ok) throw parseError(await response.json(), response.status);
    if (response.status !== status) invalid();
    return parse(status === 204 ? undefined : await response.json());
  } catch (error) {
    const failure = error instanceof PortalError ? error : new PortalError("invalid_response");
    throw new PortalError(
      failure.kind,
      response.status,
      failure.code,
      creating && (failure.kind === "invalid_response" || failure.kind === "server"),
    );
  }
}

export async function listKeys(token: string, { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {}) {
  if (!integer(limit, 1, 100) || !integer(offset, 0)) throw new PortalError("validation");
  return request(token, `/keys?limit=${limit}&offset=${offset}`, "GET", 200, parseList);
}
export async function createKey(token: string, selectedScopes: readonly KeyScope[]) {
  if (!scopes(selectedScopes)) throw new PortalError("validation");
  return request(token, "/keys", "POST", 201, parseCreated, JSON.stringify({ scopes: [...selectedScopes] }));
}
export async function revokeKey(token: string, id: string): Promise<void> {
  if (!uuid.test(id)) throw new PortalError("validation");
  return request(token, `/keys/${id}`, "DELETE", 204, () => undefined);
}
export async function getUsage(token: string) {
  return request(token, "/usage", "GET", 200, parseUsage);
}

// Client-derived key counts for the Overview summary card. The API exposes no
// aggregate, so page through every key (largest page size, following has_more)
// and fold the results. "last activity" is the most recently used key.
export interface KeySummary {
  active: number;
  revoked: number;
  lastUsedAt: string | null;
  lastPrefix: string | null;
}

export async function summarizeKeys(token: string): Promise<KeySummary> {
  let offset = 0;
  let active = 0;
  let revoked = 0;
  let lastUsedAt: string | null = null;
  let lastPrefix: string | null = null;
  for (;;) {
    const page = await listKeys(token, { limit: 100, offset });
    for (const key of page.data) {
      if (key.revoked_at === null) active += 1;
      else revoked += 1;
      // Timestamps are canonical ISO strings, so lexical order is chronological.
      if (key.last_used_at !== null && (lastUsedAt === null || key.last_used_at > lastUsedAt)) {
        lastUsedAt = key.last_used_at;
        lastPrefix = key.prefix;
      }
    }
    if (!page.has_more || page.data.length === 0) break;
    offset += page.limit;
  }
  return { active, revoked, lastUsedAt, lastPrefix };
}
