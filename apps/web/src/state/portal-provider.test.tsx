import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as auth from "../auth";
import type { CreatedKey, KeyList, KeyMetadata, OwnerUsage } from "../portal-api";
import * as api from "../portal-api";
import { useAppActions, useAppState } from "./context";
import { PortalProvider } from "./portal-provider";

vi.mock("../auth", async (original) => ({
  ...(await original<typeof auth>()),
  readToken: vi.fn(),
  getIdentity: vi.fn(),
  login: vi.fn(),
  storeToken: vi.fn(),
  clearToken: vi.fn(),
}));
vi.mock("../portal-api", async (original) => ({
  ...(await original<typeof api>()),
  getUsage: vi.fn(),
  listKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  summarizeKeys: vi.fn(),
}));

const user = { id: "owner-1", username: "demo" };
const token = "header.payload.signature";
const metaKey: KeyMetadata = {
  id: "11111111-1111-1111-1111-111111111111",
  prefix: "ghk_live_7f3a",
  scopes: ["search:read", "keys:manage"],
  created_at: "2026-10-02T00:00:00.000Z",
  last_used_at: "2026-11-01T00:00:00.000Z",
  revoked_at: null,
};
const page: KeyList = { data: [metaKey], limit: 20, offset: 0, has_more: false };
const usage: OwnerUsage = {
  data: {
    period_start: "2026-11-01T00:00:00.000Z",
    period_end: "2026-12-01T00:00:00.000Z",
    billable_calls: 642,
    quota: 1000,
    remaining: 358,
  },
};
const created: CreatedKey = { data: metaKey, secret: `ghk_${"a".repeat(43)}` };
const summary = { active: 1, revoked: 0, lastUsedAt: metaKey.last_used_at, lastPrefix: metaKey.prefix };

function Harness() {
  const state = useAppState();
  const actions = useAppActions();
  return (
    <div>
      <output data-testid="session">{state.session.status}</output>
      <output data-testid="session-error">{state.session.error}</output>
      <output data-testid="usage">{state.usage.status}</output>
      <output data-testid="keys">{state.keys.status}</output>
      <output data-testid="summary">{state.summary.status}</output>
      <output data-testid="secret">{state.create.secret}</output>
      <output data-testid="modal">{state.ui.modal}</output>
      <output data-testid="toast">{state.ui.toast ?? ""}</output>
      <button type="button" onClick={() => void actions.signIn({ username: "demo", password: "pw" })}>
        signin
      </button>
      <button type="button" onClick={() => actions.openCreate()}>
        opencreate
      </button>
      <button type="button" onClick={() => actions.toggleCreateScope("search:read")}>
        scope
      </button>
      <button type="button" onClick={() => void actions.createKey()}>
        create
      </button>
      <button type="button" onClick={() => actions.openRevoke(metaKey)}>
        openrevoke
      </button>
      <button type="button" onClick={() => void actions.revokeKey(metaKey.id)}>
        revoke
      </button>
      <button type="button" onClick={() => actions.signOut()}>
        signout
      </button>
    </div>
  );
}

async function mountAnonymous() {
  vi.mocked(auth.readToken).mockReturnValue(null);
  render(
    <PortalProvider>
      <Harness />
    </PortalProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("anonymous"));
  return userEvent.setup();
}

async function signInAndHydrate() {
  const u = await mountAnonymous();
  vi.mocked(auth.login).mockResolvedValue({ token, user });
  vi.mocked(auth.getIdentity).mockResolvedValue({ user });
  await u.click(screen.getByRole("button", { name: "signin" }));
  await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("authenticated"));
  return u;
}

beforeEach(() => {
  vi.mocked(api.getUsage).mockResolvedValue(usage);
  vi.mocked(api.listKeys).mockResolvedValue(page);
  vi.mocked(api.summarizeKeys).mockResolvedValue(summary);
  vi.mocked(api.createKey).mockResolvedValue(created);
  vi.mocked(api.revokeKey).mockResolvedValue(undefined);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("restores an anonymous session when there is no stored token", async () => {
  await mountAnonymous();
  expect(api.listKeys).not.toHaveBeenCalled();
  expect(api.getUsage).not.toHaveBeenCalled();
});

it("hydrates usage, keys and summary after a successful sign-in", async () => {
  await signInAndHydrate();
  await waitFor(() => {
    expect(screen.getByTestId("usage").textContent).toBe("ready");
    expect(screen.getByTestId("keys").textContent).toBe("ready");
    expect(screen.getByTestId("summary").textContent).toBe("ready");
  });
  expect(auth.storeToken).toHaveBeenCalledWith(token);
  expect(api.listKeys).toHaveBeenCalledWith(token, { limit: 20, offset: 0 });
  expect(api.getUsage).toHaveBeenCalledWith(token);
  expect(api.summarizeKeys).toHaveBeenCalledWith(token);
});

it("surfaces a sign-in error without leaving the anonymous state", async () => {
  const u = await mountAnonymous();
  vi.mocked(auth.login).mockRejectedValue(new auth.AuthError("unauthenticated", "no", 401));
  await u.click(screen.getByRole("button", { name: "signin" }));
  await waitFor(() => expect(screen.getByTestId("session-error").textContent ?? "").toMatch(/username or password/i));
  expect(screen.getByTestId("session").textContent).toBe("anonymous");
  expect(api.listKeys).not.toHaveBeenCalled();
});

it("createKey reveals the secret once, then re-pulls keys and summary", async () => {
  const u = await signInAndHydrate();
  const keysBefore = vi.mocked(api.listKeys).mock.calls.length;
  const summaryBefore = vi.mocked(api.summarizeKeys).mock.calls.length;

  await u.click(screen.getByRole("button", { name: "opencreate" }));
  await u.click(screen.getByRole("button", { name: "scope" }));
  await u.click(screen.getByRole("button", { name: "create" }));

  await waitFor(() => expect(screen.getByTestId("secret").textContent).toBe(created.secret));
  expect(api.createKey).toHaveBeenCalledWith(token, ["search:read"]);
  // Re-pull: one more listKeys and one more summarizeKeys than the hydrate did.
  await waitFor(() => {
    expect(vi.mocked(api.listKeys).mock.calls.length).toBe(keysBefore + 1);
    expect(vi.mocked(api.summarizeKeys).mock.calls.length).toBe(summaryBefore + 1);
  });
});

it("revokeKey closes the dialog, raises a toast, then re-pulls keys and summary", async () => {
  const u = await signInAndHydrate();
  const keysBefore = vi.mocked(api.listKeys).mock.calls.length;
  const summaryBefore = vi.mocked(api.summarizeKeys).mock.calls.length;

  await u.click(screen.getByRole("button", { name: "openrevoke" }));
  expect(screen.getByTestId("modal").textContent).toBe("revoke");
  await u.click(screen.getByRole("button", { name: "revoke" }));

  await waitFor(() => {
    expect(screen.getByTestId("modal").textContent).toBe("none");
    expect(screen.getByTestId("toast").textContent).toBe(`API key ${metaKey.prefix} revoked.`);
  });
  expect(api.revokeKey).toHaveBeenCalledWith(token, metaKey.id);
  await waitFor(() => {
    expect(vi.mocked(api.listKeys).mock.calls.length).toBe(keysBefore + 1);
    expect(vi.mocked(api.summarizeKeys).mock.calls.length).toBe(summaryBefore + 1);
  });
});

it("signing out clears the session and its data, and forgets the token", async () => {
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: "signout" }));
  await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("anonymous"));
  expect(auth.clearToken).toHaveBeenCalled();
  expect(screen.getByTestId("keys").textContent).toBe("idle");
  expect(screen.getByTestId("usage").textContent).toBe("idle");
});
