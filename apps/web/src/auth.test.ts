import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToken, readToken, storeToken, TOKEN_STORAGE_KEY } from "./auth";

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

  it.each([
    "",
    "null",
    "undefined",
    "{}",
    "abc",
    "a.b",
    "a.b.c.d",
    "a. .c",
    '"a.b.c"',
    "a.b.c\n",
  ])("discards malformed stored value %j without decoding claims", (value) => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    expect(readToken()).toBeNull();
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("rejects malformed writes without persisting them", () => {
    expect(() => storeToken("not a JWT")).toThrow();
    expect(sessionStorage.length).toBe(0);
  });

  it.each(["getItem", "setItem", "removeItem"] as const)(
    "reports sanitized storage failure for %s",
    (method) => {
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
    },
  );
});
