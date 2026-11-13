import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createKey, getUsage, type KeyMetadata, listKeys, revokeKey, summarizeKeys } from "../src/portal-api";

const token = "header.payload.signature";
const id = "06a9d160-b0b4-4e51-9809-f244d57e361e";
const secret = `ghk_${"a".repeat(43)}`;
const key = {
  id,
  prefix: secret.slice(0, 12),
  scopes: ["search:read", "keys:manage"],
  created_at: "2026-11-01T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};
const list = { data: [key], limit: 20, offset: 0, has_more: false };
const usage = {
  data: {
    period_start: "2026-11-01T00:00:00.000Z",
    period_end: "2026-12-01T00:00:00.000Z",
    billable_calls: 7,
    quota: 1000,
    remaining: 993,
  },
};
function respond(body: unknown, status = 200) {
  const fetcher = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function failure(code: string, retryable = false) {
  return { error: { code, message: secret, next_action: secret, retryable, details: [] } };
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses relative JWT-only portal requests with explicit safe fetch options and allowlisted output", async () => {
  const fetcher = respond({ ...list, secret, data: [{ ...key, key_hash: "private", user_id: "private", secret }] });
  expect(await listKeys(token)).toEqual(list);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/portal/keys?limit=20&offset=0", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  respond({ ...usage, owner_id: "private" });
  expect(await getUsage(token)).toEqual(usage);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/portal/usage", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
});
it("posts only explicit scopes, reveals the validated secret once and never persists or logs it", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const logs = ["log", "info", "warn", "error", "debug"].map((method) =>
    vi.spyOn(console, method as "log").mockImplementation(() => {}),
  );
  const fetcher = respond({ data: { ...key, user_id: "private" }, secret, key_hash: "private" }, 201);
  expect(await createKey(token, ["search:read", "keys:manage"])).toEqual({ data: key, secret });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/portal/keys", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scopes: ["search:read", "keys:manage"] }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  expect(storage).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
  expect(document.cookie).toBe("");
});
it("encodes only validated pagination and handles empty 204 revocation without JSON parsing", async () => {
  const fetcher = respond({ ...list, limit: 1, offset: 20 });
  expect(await listKeys(token, { limit: 1, offset: 20 })).toEqual({ ...list, limit: 1, offset: 20 });
  expect(fetcher.mock.calls[0][0]).toBe("/api/portal/keys?limit=1&offset=20");
  const response = new Response(null, { status: 204 });
  const json = vi.spyOn(response, "json");
  fetcher.mockResolvedValueOnce(response);
  await expect(revokeKey(token, id)).resolves.toBeUndefined();
  expect(json).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[1]).toEqual([
    `/api/portal/keys/${id}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
  ]);
});
it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 }])(
  "rejects invalid pagination locally: %j",
  async (pagination) => {
    const fetcher = respond(list);
    await expect(listKeys(token, pagination)).rejects.toMatchObject({ kind: "validation" });
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("rejects credential substitution, path injection and missing scopes before fetch", async () => {
  const fetcher = respond(list);
  await expect(listKeys(secret)).rejects.toMatchObject({ kind: "unauthenticated" });
  await expect(listKeys("bad\r\nheader")).rejects.toMatchObject({ kind: "unauthenticated" });
  await expect(revokeKey(token, "../usage?owner=other")).rejects.toMatchObject({ kind: "validation" });
  await expect(createKey(token, [])).rejects.toMatchObject({ kind: "validation", creationOutcomeUnknown: false });
  await expect(createKey(token, ["search:read", "search:read"])).rejects.toMatchObject({ kind: "validation" });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  null,
  {},
  { ...list, data: null },
  { ...list, has_more: "false" },
  { ...list, limit: 0 },
  { ...list, offset: -1 },
  { ...list, data: [{ ...key, id: "bad" }] },
  { ...list, data: [{ ...key, prefix: "" }] },
  { ...list, data: [{ ...key, scopes: [] }] },
  { ...list, data: [{ ...key, scopes: ["unknown"] }] },
  { ...list, data: [{ ...key, scopes: ["search:read", "search:read"] }] },
  { ...list, data: [{ ...key, created_at: "2026-02-30T00:00:00.000Z" }] },
  { ...list, data: [{ ...key, last_used_at: false }] },
  { ...list, data: [{ ...key, revoked_at: "yesterday" }] },
])("rejects malformed key/list responses: %j", async (body) => {
  respond(body);
  await expect(listKeys(token)).rejects.toMatchObject({ kind: "invalid_response" });
});
it.each([
  null,
  {},
  { data: { ...usage.data, billable_calls: -1 } },
  { data: { ...usage.data, billable_calls: 0.5 } },
  { data: { ...usage.data, remaining: 1000 } },
  { data: { ...usage.data, quota: 2000 } },
  { data: { ...usage.data, period_start: "bad" } },
  { data: { ...usage.data, period_end: "2026-11-02T00:00:00.000Z" } },
])("rejects malformed/incoherent usage rather than displaying invented values: %j", async (body) => {
  respond(body);
  await expect(getUsage(token)).rejects.toMatchObject({ kind: "invalid_response" });
});
it.each([{ data: key }, { data: key, secret: "prefix-only" }, { data: { ...key, prefix: "mismatched" }, secret }])(
  "preserves unknown-creation recovery for malformed success: %j",
  async (body) => {
    const fetcher = respond(body, 201);
    await expect(createKey(token, ["search:read"])).rejects.toMatchObject({
      kind: "invalid_response",
      creationOutcomeUnknown: true,
      message: expect.stringContaining("List and revoke"),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each([
  [400, "MALFORMED_JSON", "validation"],
  [403, "INSUFFICIENT_SCOPE", "forbidden"],
  [404, "KEY_NOT_FOUND", "not_found"],
  [409, "IDEMPOTENCY_CONFLICT", "conflict"],
  [413, "BODY_TOO_LARGE", "validation"],
  [422, "VALIDATION_ERROR", "validation"],
  [500, "INTERNAL_ERROR", "server"],
])("classifies valid HTTP %s/%s without exposing messages or retrying", async (status, code, kind) => {
  const fetcher = respond(failure(code, status === 500), status);
  await expect(createKey(token, ["search:read"])).rejects.toMatchObject({
    kind,
    code,
    status,
    creationOutcomeUnknown: status === 500,
    message: expect.not.stringContaining(secret),
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("401 is authoritative without altering tab state, even with a non-JSON upstream body", async () => {
  sessionStorage.setItem("gethookd.auth.token", token);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private", { status: 401 })));
  await expect(listKeys(token)).rejects.toMatchObject({ kind: "unauthenticated", status: 401 });
  expect(sessionStorage.getItem("gethookd.auth.token")).toBe(token);
});
it.each([
  failure("VALIDATION_ERROR"),
  { error: { code: "INTERNAL_ERROR" } },
  { error: { ...failure("INTERNAL_ERROR", true).error, details: [null] } },
  {
    error: {
      ...failure("INTERNAL_ERROR", true).error,
      details: [{ parameter: "x", reason: "x", allowed_values: [1], suggestion: null }],
    },
  },
])("rejects mismatched status/code and malformed error envelopes: %j", async (body) => {
  respond(body, 500);
  await expect(getUsage(token)).rejects.toMatchObject({ kind: "invalid_response", status: 500 });
});
it("sanitizes network/redirect rejection and unreadable/wrong-status responses without retries", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error(secret));
  vi.stubGlobal("fetch", fetcher);
  await expect(createKey(token, ["search:read"])).rejects.toMatchObject({
    kind: "network",
    creationOutcomeUnknown: true,
  });
  await expect(getUsage(token)).rejects.toMatchObject({ kind: "network", creationOutcomeUnknown: false });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce(new Response(secret));
  await expect(getUsage(token)).rejects.toMatchObject({ kind: "invalid_response" });
  fetcher.mockResolvedValueOnce(Response.json({ data: key, secret }, { status: 200 }));
  await expect(createKey(token, ["search:read"])).rejects.toMatchObject({
    kind: "invalid_response",
    creationOutcomeUnknown: true,
  });
  fetcher.mockResolvedValueOnce(Response.json({}, { status: 200 }));
  await expect(revokeKey(token, id)).rejects.toMatchObject({ kind: "invalid_response" });
});

const uuids = [
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333",
  "44444444-4444-4444-4444-444444444444",
  "55555555-5555-5555-5555-555555555555",
];
function keyAt(i: number, over: Partial<KeyMetadata> = {}): KeyMetadata {
  return {
    ...key,
    scopes: [...key.scopes] as KeyMetadata["scopes"],
    id: uuids[i],
    prefix: `ghk_live_000${i}`,
    ...over,
  };
}
it("summarizeKeys pages every key (limit 100, following has_more) and aggregates counts", async () => {
  const pageOne = {
    data: [
      keyAt(0, { last_used_at: "2026-11-01T00:00:00.000Z", revoked_at: null }),
      keyAt(1, { last_used_at: null, revoked_at: "2026-11-02T00:00:00.000Z" }),
      keyAt(2, { last_used_at: null, revoked_at: null }),
    ],
    limit: 100,
    offset: 0,
    has_more: true,
  };
  const pageTwo = {
    data: [
      keyAt(3, { prefix: "ghk_live_last", last_used_at: "2026-11-05T00:00:00.000Z", revoked_at: null }),
      keyAt(4, { last_used_at: "2026-10-01T00:00:00.000Z", revoked_at: "2026-11-03T00:00:00.000Z" }),
    ],
    limit: 100,
    offset: 100,
    has_more: false,
  };
  const fetcher = vi.fn();
  fetcher.mockResolvedValueOnce(Response.json(pageOne)).mockResolvedValueOnce(Response.json(pageTwo));
  vi.stubGlobal("fetch", fetcher);
  expect(await summarizeKeys(token)).toEqual({
    active: 3,
    revoked: 2,
    lastUsedAt: "2026-11-05T00:00:00.000Z",
    lastPrefix: "ghk_live_last",
  });
  expect(fetcher).toHaveBeenNthCalledWith(1, "/api/portal/keys?limit=100&offset=0", expect.anything());
  expect(fetcher).toHaveBeenNthCalledWith(2, "/api/portal/keys?limit=100&offset=100", expect.anything());
});
it("summarizeKeys reports no activity when no key has ever been used", async () => {
  respond({
    data: [
      keyAt(0, { last_used_at: null, revoked_at: null }),
      keyAt(1, { last_used_at: null, revoked_at: "2026-11-02T00:00:00.000Z" }),
    ],
    limit: 100,
    offset: 0,
    has_more: false,
  });
  expect(await summarizeKeys(token)).toEqual({ active: 1, revoked: 1, lastUsedAt: null, lastPrefix: null });
});
