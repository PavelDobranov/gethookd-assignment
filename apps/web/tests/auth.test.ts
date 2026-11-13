import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearToken, getIdentity, login, readToken, storeToken, TOKEN_STORAGE_KEY } from "../src/auth";

const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const user = { id: "server-user-id", username: "server-name" };

function mockResponse(body: unknown, status = 200) {
  const http = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal("fetch", http);
  return http;
}

describe("auth HTTP boundary", () => {
  it("posts exact credentials to a relative URL and allowlists login output", async () => {
    const http = mockResponse({
      token,
      user: { ...user, passwordHash: "private" },
      extra: "private",
    });
    const result = await login({ username: " demo ", password: " password " });
    expect(result).toEqual({ token, user });
    expect(http).toHaveBeenCalledExactlyOnceWith("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: " demo ", password: " password " }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("gets identity from the server with Bearer auth, never from JWT claims", async () => {
    const http = mockResponse({
      user: { ...user, passwordHash: "private" },
      token: "ignored",
    });
    expect(await getIdentity(token)).toEqual({ user });
    expect(http).toHaveBeenCalledExactlyOnceWith("/api/auth/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    null,
    {},
    { user: null },
    { user: [] },
    { user: { id: 1, username: "demo" } },
    { user: { id: "", username: "demo" } },
    { user: { id: "id", username: "" } },
    { user: { id: "id", username: false } },
  ])("rejects invalid identity output %j", async (body) => {
    mockResponse(body);
    await expect(getIdentity(token)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it.each([
    null,
    {},
    { user },
    { token: 3, user },
    { token: "", user },
    { token: "invalid", user },
    { token, user: null },
  ])("rejects invalid login output %j", async (body) => {
    mockResponse(body);
    await expect(login({ username: "demo", password: "password" })).rejects.toMatchObject({ kind: "invalid_response" });
    expect(sessionStorage.length).toBe(0);
  });

  it("sanitizes non-JSON success output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private server details")));
    await expect(getIdentity(token)).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Invalid authentication response.",
    });
  });

  it.each([
    [401, "unauthenticated"],
    [400, "request"],
    [422, "request"],
    [429, "request"],
    [500, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
  ])("classifies HTTP %s as %s without exposing the body or retrying", async (status, kind) => {
    const http = mockResponse({ error: { message: "private details" }, token }, Number(status));
    storeToken(token);
    await expect(getIdentity(token)).rejects.toMatchObject({
      kind,
      status,
      message: expect.not.stringContaining("private"),
    });
    expect(http).toHaveBeenCalledTimes(1);
    // Auth-state transitions belong to the UI, not the HTTP boundary.
    expect(readToken()).toBe(token);
  });

  it("classifies login 401 separately from service failures", async () => {
    const http = mockResponse({}, 401);
    await expect(login({ username: "demo", password: "wrong" })).rejects.toMatchObject({
      kind: "unauthenticated",
      status: 401,
    });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network failures without retrying or clearing stored tokens", async () => {
    const http = vi.fn().mockRejectedValue(new Error(`private details ${token}`));
    vi.stubGlobal("fetch", http);
    storeToken(token);
    await expect(getIdentity(token)).rejects.toMatchObject({
      kind: "unavailable",
      message: "Authentication service is unavailable.",
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(readToken()).toBe(token);
  });

  it("rejects malformed header tokens before issuing a request", async () => {
    const http = mockResponse({ user });
    await expect(getIdentity("bad\r\nheader")).rejects.toMatchObject({
      kind: "unauthenticated",
    });
    expect(http).not.toHaveBeenCalled();
  });
});

describe("tab token storage", () => {
  it("persists only the JWT and restores it across reads", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    storeToken(token);
    expect(setItem).toHaveBeenCalledExactlyOnceWith(TOKEN_STORAGE_KEY, token);
    expect(sessionStorage.length).toBe(1);
    expect(readToken()).toBe(token);
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("removes only the token on logout", () => {
    sessionStorage.setItem("unrelated", "keep");
    storeToken(token);
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    clearToken();
    expect(removeItem).toHaveBeenCalledExactlyOnceWith(TOKEN_STORAGE_KEY);
    expect(readToken()).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
  });

  it("returns null for absent storage", () => {
    expect(readToken()).toBeNull();
  });

  it.each(["", "null", "undefined", "{}", "abc", "a.b", "a.b.c.d", "a. .c", '"a.b.c"', "a.b.c\n"])(
    "discards malformed stored value %j without decoding claims",
    (value) => {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
      expect(readToken()).toBeNull();
      expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    },
  );

  it("rejects malformed writes without persisting them", () => {
    expect(() => storeToken("not a JWT")).toThrow();
    expect(sessionStorage.length).toBe(0);
  });

  it.each(["getItem", "setItem", "removeItem"] as const)("reports sanitized storage failure for %s", (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error("private browser details");
    });
    const operation = {
      getItem: readToken,
      setItem: () => storeToken(token),
      removeItem: clearToken,
    }[method];
    expect(operation).toThrow(
      expect.objectContaining({
        kind: "storage",
        message: "Session storage is unavailable.",
      }),
    );
  });
});
