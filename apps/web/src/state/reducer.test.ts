import { describe, expect, it } from "vitest";

import type { KeyList, KeyMetadata } from "../portal-api";
import { appReducer } from "./reducer";
import type { AppState } from "./types";
import { initialState } from "./types";

const user = { id: "u1", username: "demo" };

function activeKey(overrides: Partial<KeyMetadata> = {}): KeyMetadata {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    prefix: "ghk_live_7f3a",
    scopes: ["search:read"],
    created_at: "2026-10-02T00:00:00.000Z",
    last_used_at: "2026-11-01T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

function keyList(overrides: Partial<KeyList> = {}): KeyList {
  return { data: [activeKey()], limit: 20, offset: 0, has_more: false, ...overrides };
}

describe("appReducer", () => {
  it("is pure — never mutates the input state", () => {
    const snapshot = JSON.stringify(initialState);
    appReducer(initialState, { type: "ui/setView", view: "keys" });
    appReducer(initialState, { type: "session/authenticated", user, token: "a.b.c" });
    appReducer(initialState, { type: "ui/toggleCreateScope", scope: "search:read" });
    expect(JSON.stringify(initialState)).toBe(snapshot);
  });

  it("returns the same reference for an unknown action", () => {
    // @ts-expect-error — exercising the runtime default branch.
    expect(appReducer(initialState, { type: "nope" })).toBe(initialState);
  });

  describe("session", () => {
    it("authenticated sets the session and starts from cleared slices", () => {
      const dirty: AppState = {
        ...initialState,
        usage: { status: "ready", data: null },
        ui: { ...initialState.ui, view: "usage", toast: "old" },
      };
      const next = appReducer(dirty, { type: "session/authenticated", user, token: "a.b.c" });
      expect(next.session).toEqual({ status: "authenticated", user, token: "a.b.c", error: "" });
      expect(next.ui.view).toBe("overview");
      expect(next.ui.toast).toBeNull();
      expect(next.usage.status).toBe("idle");
    });

    it("anonymous and checking wipe every non-session slice", () => {
      const dirty = appReducer(initialState, { type: "session/authenticated", user, token: "a.b.c" });
      for (const type of ["session/anonymous", "session/checking"] as const) {
        const next = appReducer(dirty, { type });
        expect(next.session.user).toBeNull();
        expect(next.session.token).toBe("");
        expect(next.usage).toEqual(initialState.usage);
        expect(next.keys).toEqual(initialState.keys);
      }
    });

    it("unavailable preserves other slices and records the error", () => {
      const next = appReducer(initialState, { type: "session/unavailable", error: "down" });
      expect(next.session.status).toBe("unavailable");
      expect(next.session.error).toBe("down");
      expect(next.usage).toBe(initialState.usage);
    });
  });

  describe("ui", () => {
    it("toggles create scopes on and off, preserving order", () => {
      let state = appReducer(initialState, { type: "ui/toggleCreateScope", scope: "search:read" });
      state = appReducer(state, { type: "ui/toggleCreateScope", scope: "keys:manage" });
      expect(state.ui.createDraft.scopes).toEqual(["search:read", "keys:manage"]);
      state = appReducer(state, { type: "ui/toggleCreateScope", scope: "search:read" });
      expect(state.ui.createDraft.scopes).toEqual(["keys:manage"]);
    });

    it("openCreate opens the modal with a fresh draft and no secret", () => {
      const seeded = appReducer(initialState, { type: "create/success", secret: "ghk_live_x" });
      const next = appReducer(seeded, { type: "ui/openCreate" });
      expect(next.ui.modal).toBe("create");
      expect(next.ui.createDraft.scopes).toEqual([]);
      expect(next.create.secret).toBe("");
    });

    it("openRevoke targets the key", () => {
      const key = activeKey();
      const next = appReducer(initialState, { type: "ui/openRevoke", key });
      expect(next.ui.modal).toBe("revoke");
      expect(next.ui.revokeTarget).toBe(key);
    });

    it("closeModal clears modal, draft and the reveal-once secret", () => {
      let state = appReducer(initialState, { type: "ui/openCreate" });
      state = appReducer(state, { type: "ui/toggleCreateScope", scope: "search:read" });
      state = appReducer(state, { type: "create/success", secret: "ghk_live_secret" });
      const next = appReducer(state, { type: "ui/closeModal" });
      expect(next.ui.modal).toBe("none");
      expect(next.ui.revokeTarget).toBeNull();
      expect(next.ui.createDraft.scopes).toEqual([]);
      expect(next.create.secret).toBe("");
    });

    it("changing view also clears modal, draft and secret but keeps the toast", () => {
      let state = appReducer(initialState, { type: "ui/setToast", toast: "done" });
      state = appReducer(state, { type: "ui/openCreate" });
      state = appReducer(state, { type: "create/success", secret: "ghk_live_secret" });
      const next = appReducer(state, { type: "ui/setView", view: "usage" });
      expect(next.ui.view).toBe("usage");
      expect(next.ui.modal).toBe("none");
      expect(next.create.secret).toBe("");
      expect(next.ui.toast).toBe("done");
    });

    it("sets and dismisses the toast", () => {
      const set = appReducer(initialState, { type: "ui/setToast", toast: "revoked" });
      expect(set.ui.toast).toBe("revoked");
      expect(appReducer(set, { type: "ui/dismissToast" }).ui.toast).toBeNull();
    });
  });

  describe("usage", () => {
    it("moves through loading, ready and error", () => {
      const data = {
        period_start: "2026-11-01T00:00:00.000Z",
        period_end: "2026-12-01T00:00:00.000Z",
        billable_calls: 642,
        quota: 1000,
        remaining: 358,
      };
      expect(appReducer(initialState, { type: "usage/loading" }).usage.status).toBe("loading");
      const ready = appReducer(initialState, { type: "usage/ready", data });
      expect(ready.usage).toEqual({ status: "ready", data });
      expect(appReducer(ready, { type: "usage/error" }).usage.status).toBe("error");
    });
  });

  describe("keys", () => {
    it("loading records the requested pagination and clears the error", () => {
      const errored = appReducer(initialState, { type: "keys/error", error: "boom" });
      const next = appReducer(errored, { type: "keys/loading", pagination: { limit: 20, offset: 20 } });
      expect(next.keys.status).toBe("loading");
      expect(next.keys.pagination).toEqual({ limit: 20, offset: 20 });
      expect(next.keys.error).toBe("");
    });

    it("ready stores the page and derives pagination from the response", () => {
      const page = keyList({ limit: 20, offset: 40 });
      const next = appReducer(initialState, { type: "keys/ready", page });
      expect(next.keys.status).toBe("ready");
      expect(next.keys.page).toBe(page);
      expect(next.keys.pagination).toEqual({ limit: 20, offset: 40 });
    });

    it("tracks the mutating flag independently of load status", () => {
      const ready = appReducer(initialState, { type: "keys/ready", page: keyList() });
      const mutating = appReducer(ready, { type: "keys/mutating", mutating: true });
      expect(mutating.keys.mutating).toBe(true);
      expect(mutating.keys.status).toBe("ready");
      expect(appReducer(mutating, { type: "keys/mutating", mutating: false }).keys.mutating).toBe(false);
    });
  });

  describe("summary", () => {
    it("stores aggregated counts on ready", () => {
      const summary = { active: 3, revoked: 1, lastUsedAt: "2026-11-01T00:00:00.000Z", lastPrefix: "ghk_live_7f3a" };
      const next = appReducer(initialState, { type: "summary/ready", summary });
      expect(next.summary).toEqual({ status: "ready", ...summary });
    });
  });

  describe("create", () => {
    it("pending clears any prior secret and error", () => {
      const seeded = appReducer(initialState, { type: "create/error", error: "nope" });
      expect(appReducer(seeded, { type: "create/pending" }).create).toEqual({
        pending: true,
        secret: "",
        error: "",
      });
    });

    it("success reveals the secret and dismissSecret clears it", () => {
      const ok = appReducer(initialState, { type: "create/success", secret: "ghk_live_secret" });
      expect(ok.create).toEqual({ pending: false, secret: "ghk_live_secret", error: "" });
      expect(appReducer(ok, { type: "create/dismissSecret" }).create.secret).toBe("");
    });
  });
});
