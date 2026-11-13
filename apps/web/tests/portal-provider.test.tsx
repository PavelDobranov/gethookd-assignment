import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as auth from "../src/auth";
import type { CreatedKey, KeyList, KeyMetadata, OwnerUsage } from "../src/portal-api";
import * as api from "../src/portal-api";
import { useAppActions, useAppState } from "../src/state/context";
import { PortalProvider } from "../src/state/portal-provider";

vi.mock("../src/auth", async (original) => ({
  ...(await original<typeof auth>()),
  readToken: vi.fn(),
  getIdentity: vi.fn(),
  login: vi.fn(),
  storeToken: vi.fn(),
  clearToken: vi.fn(),
}));
vi.mock("../src/portal-api", async (original) => ({
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
      <output data-testid="create-error">{state.create.error}</output>
      <output data-testid="pending">{String(state.create.pending)}</output>
      <output data-testid="mutating">{String(state.keys.mutating)}</output>
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
      <button type="button" onClick={() => void actions.restoreSession()}>
        restore
      </button>
      <button type="button" onClick={() => actions.closeModal()}>
        close
      </button>
      <button type="button" onClick={() => actions.setView("usage")}>
        view
      </button>
      <button type="button" onClick={() => actions.dismissSecret()}>
        dismisssecret
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
  vi.resetAllMocks();
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

it("clears a previous toast before opening a revoke dialog", async () => {
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: "openrevoke" }));
  await u.click(screen.getByRole("button", { name: "revoke" }));
  await waitFor(() => expect(screen.getByTestId("toast").textContent).toContain("revoked."));
  await u.click(screen.getByRole("button", { name: "openrevoke" }));
  expect(screen.getByTestId("modal").textContent).toBe("revoke");
  expect(screen.getByTestId("toast").textContent).toBe("");
});

it("signing out clears the session and its data, and forgets the token", async () => {
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: "signout" }));
  await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("anonymous"));
  expect(auth.clearToken).toHaveBeenCalled();
  expect(screen.getByTestId("keys").textContent).toBe("idle");
  expect(screen.getByTestId("usage").textContent).toBe("idle");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("reports storage-read failures on the anonymous session", async () => {
  vi.mocked(auth.readToken).mockImplementationOnce(() => {
    throw new auth.AuthError("storage", "Session storage is unavailable.");
  });
  render(
    <PortalProvider>
      <Harness />
    </PortalProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("anonymous"));
  expect(screen.getByTestId("session-error").textContent).toBe("Session storage is unavailable.");
});

it("rejects create without scopes before making a request", async () => {
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: "opencreate" }));
  await u.click(screen.getByRole("button", { name: "create" }));
  expect(api.createKey).not.toHaveBeenCalled();
  expect(screen.getByTestId("create-error").textContent).toBe("Select at least one scope.");
  expect(screen.getByTestId("pending").textContent).toBe("false");
  expect(screen.getByTestId("mutating").textContent).toBe("false");
});

it.each(["close", "view", "opencreate", "openrevoke", "dismisssecret"])(
  "does not reveal a late create secret after %s, but refreshes same-session resources",
  async (invalidate) => {
    const request = deferred<CreatedKey>();
    vi.mocked(api.createKey).mockReturnValueOnce(request.promise);
    const u = await signInAndHydrate();
    await u.click(screen.getByRole("button", { name: "opencreate" }));
    await u.click(screen.getByRole("button", { name: "scope" }));
    await u.click(screen.getByRole("button", { name: "create" }));
    await u.click(screen.getByRole("button", { name: invalidate }));
    if (invalidate === "close") await u.click(screen.getByRole("button", { name: "opencreate" }));
    const modal = screen.getByTestId("modal").textContent;
    const keysBefore = vi.mocked(api.listKeys).mock.calls.length;
    const summaryBefore = vi.mocked(api.summarizeKeys).mock.calls.length;
    await act(async () => request.resolve(created));
    expect(screen.getByTestId("secret").textContent).toBe("");
    expect(screen.getByTestId("modal").textContent).toBe(modal);
    expect(api.listKeys).toHaveBeenCalledTimes(keysBefore + 1);
    expect(api.summarizeKeys).toHaveBeenCalledTimes(summaryBefore + 1);
  },
);

it.each(["create", "revoke"] as const)("does not apply a late %s error to a reopened modal", async (kind) => {
  const request = deferred<never>();
  if (kind === "create") vi.mocked(api.createKey).mockReturnValueOnce(request.promise);
  else vi.mocked(api.revokeKey).mockReturnValueOnce(request.promise);
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: `open${kind}` }));
  if (kind === "create") await u.click(screen.getByRole("button", { name: "scope" }));
  await u.click(screen.getByRole("button", { name: kind }));
  await u.click(screen.getByRole("button", { name: "close" }));
  await u.click(screen.getByRole("button", { name: `open${kind}` }));
  await act(async () => request.reject(new Error("untrusted server detail")));
  expect(screen.getByTestId("create-error").textContent).toBe("");
  expect(screen.getByTestId("toast").textContent).toBe("");
  expect(screen.getByTestId("modal").textContent).toBe(kind);
  expect(screen.getByTestId("mutating").textContent).toBe("false");
});

it("does not close a new modal when an old revoke succeeds", async () => {
  const request = deferred<void>();
  vi.mocked(api.revokeKey).mockReturnValueOnce(request.promise);
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: "openrevoke" }));
  await u.click(screen.getByRole("button", { name: "revoke" }));
  await u.click(screen.getByRole("button", { name: "close" }));
  await u.click(screen.getByRole("button", { name: "openrevoke" }));
  await act(async () => request.resolve(undefined));
  expect(screen.getByTestId("modal").textContent).toBe("revoke");
  expect(screen.getByTestId("toast").textContent).toBe("");
  expect(api.listKeys).toHaveBeenCalledTimes(2);
  expect(api.summarizeKeys).toHaveBeenCalledTimes(2);
});

it.each(["create", "revoke"] as const)(
  "blocks duplicate and competing mutations while %s is in flight",
  async (kind) => {
    const request = deferred<never>();
    if (kind === "create") vi.mocked(api.createKey).mockReturnValueOnce(request.promise);
    else vi.mocked(api.revokeKey).mockReturnValueOnce(request.promise);
    const u = await signInAndHydrate();
    await u.click(screen.getByRole("button", { name: `open${kind}` }));
    if (kind === "create") await u.click(screen.getByRole("button", { name: "scope" }));
    await u.click(screen.getByRole("button", { name: kind }));
    await u.click(screen.getByRole("button", { name: "close" }));
    await u.click(screen.getByRole("button", { name: "opencreate" }));
    await u.click(screen.getByRole("button", { name: "scope" }));
    await u.click(screen.getByRole("button", { name: "create" }));
    await u.click(screen.getByRole("button", { name: "openrevoke" }));
    await u.click(screen.getByRole("button", { name: "revoke" }));
    expect(api.createKey).toHaveBeenCalledTimes(kind === "create" ? 1 : 0);
    expect(api.revokeKey).toHaveBeenCalledTimes(kind === "revoke" ? 1 : 0);
    await act(async () => request.reject(new Error("failed")));
    await u.click(screen.getByRole("button", { name: "revoke" }));
    expect(api.revokeKey).toHaveBeenCalledTimes(kind === "revoke" ? 2 : 1);
  },
);

it.each([
  ["create", "success", "signout"],
  ["create", "error", "signout"],
  ["revoke", "success", "signout"],
  ["revoke", "error", "signout"],
  ["create", "success", "restore"],
  ["create", "error", "restore"],
  ["revoke", "success", "restore"],
  ["revoke", "error", "restore"],
] as const)("ignores late %s %s after %s", async (kind, outcome, transition) => {
  const request = deferred<CreatedKey>();
  if (kind === "create") vi.mocked(api.createKey).mockReturnValueOnce(request.promise);
  else vi.mocked(api.revokeKey).mockReturnValueOnce(request.promise.then(() => undefined));
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: `open${kind}` }));
  if (kind === "create") await u.click(screen.getByRole("button", { name: "scope" }));
  await u.click(screen.getByRole("button", { name: kind }));
  if (transition === "restore") vi.mocked(auth.readToken).mockReturnValue(token);
  await u.click(screen.getByRole("button", { name: transition }));
  const keysBefore = vi.mocked(api.listKeys).mock.calls.length;
  const summaryBefore = vi.mocked(api.summarizeKeys).mock.calls.length;
  const clearsBefore = vi.mocked(auth.clearToken).mock.calls.length;
  await act(async () => {
    if (outcome === "error") request.reject(new auth.AuthError("unauthenticated", "Expired.", 401));
    else request.resolve(created);
  });
  expect(screen.getByTestId("session").textContent).toBe(transition === "restore" ? "authenticated" : "anonymous");
  expect(screen.getByTestId("secret").textContent).toBe("");
  expect(screen.getByTestId("toast").textContent).toBe("");
  expect(screen.getByTestId("create-error").textContent).toBe("");
  expect(api.listKeys).toHaveBeenCalledTimes(keysBefore);
  expect(api.summarizeKeys).toHaveBeenCalledTimes(summaryBefore);
  expect(auth.clearToken).toHaveBeenCalledTimes(clearsBefore);
});

it.each(["success", "error"])(
  "invalidates all resource reads at restore start before identity settles (%s)",
  async (outcome) => {
    const u = await mountAnonymous();
    const oldUsage = deferred<OwnerUsage>();
    const oldKeys = deferred<KeyList>();
    const oldSummary = deferred<typeof summary>();
    vi.mocked(auth.login).mockResolvedValue({ token, user });
    vi.mocked(auth.getIdentity).mockResolvedValue({ user });
    vi.mocked(api.getUsage).mockReturnValueOnce(oldUsage.promise);
    vi.mocked(api.listKeys).mockReturnValueOnce(oldKeys.promise);
    vi.mocked(api.summarizeKeys).mockReturnValueOnce(oldSummary.promise);
    await u.click(screen.getByRole("button", { name: "signin" }));
    vi.mocked(auth.readToken).mockReturnValue(token);
    const identity = deferred<{ user: typeof user }>();
    vi.mocked(auth.getIdentity).mockReturnValueOnce(identity.promise);
    await u.click(screen.getByRole("button", { name: "restore" }));
    await act(async () => {
      if (outcome === "success") {
        oldUsage.resolve(usage);
        oldKeys.resolve(page);
        oldSummary.resolve(summary);
      } else {
        const error = new auth.AuthError("unauthenticated", "Expired.", 401);
        oldUsage.reject(error);
        oldKeys.reject(error);
        oldSummary.reject(error);
      }
    });
    expect(screen.getByTestId("session").textContent).toBe("checking");
    for (const resource of ["usage", "keys", "summary"]) expect(screen.getByTestId(resource).textContent).toBe("idle");
    expect(auth.clearToken).not.toHaveBeenCalled();
    await act(async () => identity.resolve({ user }));
    expect(screen.getByTestId("session").textContent).toBe("authenticated");
  },
);

it("allows a new session to mutate while an old session request is pending without unlocking the new request", async () => {
  const oldRequest = deferred<CreatedKey>();
  const newRequest = deferred<CreatedKey>();
  vi.mocked(api.createKey).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const u = await signInAndHydrate();
  await u.click(screen.getByRole("button", { name: "opencreate" }));
  await u.click(screen.getByRole("button", { name: "scope" }));
  await u.click(screen.getByRole("button", { name: "create" }));
  await u.click(screen.getByRole("button", { name: "signout" }));
  await u.click(screen.getByRole("button", { name: "signin" }));
  await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("authenticated"));
  await u.click(screen.getByRole("button", { name: "opencreate" }));
  await u.click(screen.getByRole("button", { name: "scope" }));
  await u.click(screen.getByRole("button", { name: "create" }));
  expect(api.createKey).toHaveBeenCalledTimes(2);
  await act(async () => oldRequest.resolve(created));
  expect(screen.getByTestId("secret").textContent).toBe("");
  await u.click(screen.getByRole("button", { name: "create" }));
  expect(api.createKey).toHaveBeenCalledTimes(2);
  await act(async () => newRequest.resolve(created));
  expect(screen.getByTestId("secret").textContent).toBe(created.secret);
});

it("invalidates all resource reads on unmount, including late auth failures", async () => {
  const requests = [deferred<OwnerUsage>(), deferred<KeyList>(), deferred<typeof summary>()] as const;
  vi.mocked(auth.readToken).mockReturnValue(token);
  vi.mocked(auth.getIdentity).mockResolvedValue({ user });
  vi.mocked(api.getUsage).mockReturnValueOnce(requests[0].promise);
  vi.mocked(api.listKeys).mockReturnValueOnce(requests[1].promise);
  vi.mocked(api.summarizeKeys).mockReturnValueOnce(requests[2].promise);
  const mounted = render(
    <PortalProvider>
      <Harness />
    </PortalProvider>,
  );
  await waitFor(() => expect(api.summarizeKeys).toHaveBeenCalled());
  mounted.unmount();
  await act(async () => {
    for (const request of requests) request.reject(new auth.AuthError("unauthenticated", "Expired.", 401));
  });
  expect(auth.clearToken).not.toHaveBeenCalled();
});
