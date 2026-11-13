import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "../src/app";
import { TOKEN_STORAGE_KEY } from "../src/auth";
import {
  createKey,
  getUsage,
  type KeyMetadata,
  listKeys,
  PortalError,
  revokeKey,
  summarizeKeys,
} from "../src/portal-api";

vi.mock("../src/portal-api", async (original) => ({
  ...(await original<typeof import("../src/portal-api")>()),
  listKeys: vi.fn(),
  // summarizeKeys closes over the real listKeys, not the mocked module export.
  summarizeKeys: vi.fn(),
  getUsage: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
}));

const token = "header.payload.signature";
const user = { id: "server-id", username: "server-verified-user" };
const secret = `ghk_${"a".repeat(43)}`;
const key: KeyMetadata = {
  id: "11111111-1111-4111-8111-111111111111",
  prefix: secret.slice(0, 12),
  scopes: ["search:read"],
  created_at: "2026-01-01T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};
const emptyPage = { data: [], limit: 20, offset: 0, has_more: false };
const usage = {
  data: {
    period_start: "2026-06-01T00:00:00.000Z",
    period_end: "2026-07-01T00:00:00.000Z",
    billable_calls: 127,
    quota: 1000,
    remaining: 873,
  },
};
const fetchMock = vi.fn<typeof fetch>();

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(listKeys).mockResolvedValue(emptyPage);
  vi.mocked(summarizeKeys).mockResolvedValue({ active: 0, revoked: 0, lastUsedAt: null, lastPrefix: null });
  vi.mocked(getUsage).mockResolvedValue(usage);
  vi.mocked(createKey).mockResolvedValue({ data: key, secret });
  vi.mocked(revokeKey).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function submitLogin() {
  const keyboard = userEvent.setup();
  await keyboard.tab();
  expect(document.activeElement).toBe(screen.getByLabelText("Username"));
  await keyboard.keyboard("demo");
  await keyboard.tab();
  await keyboard.keyboard("demo-password{Enter}");
}

async function restore() {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  fetchMock.mockResolvedValueOnce(Response.json({ user }));
  const result = render(<App />);
  await screen.findByRole("heading", { name: "Overview" });
  await waitFor(() => expect(summarizeKeys).toHaveBeenCalledWith(token));
  return result;
}

async function openCreate() {
  await userEvent.setup().click(screen.getByRole("button", { name: "Create API key" }));
  return screen.findByRole("dialog", { name: "Create an API key" });
}

async function revealKey() {
  const dialog = await openCreate();
  const keyboard = userEvent.setup();
  await keyboard.click(within(dialog).getByRole("checkbox", { name: /search:read/ }));
  await keyboard.click(within(dialog).getByRole("button", { name: "Create key" }));
  expect(((await screen.findByLabelText("New API key")) as HTMLInputElement).value).toBe(secret);
}

function expectNoSecret() {
  expect(screen.queryByLabelText("New API key")).toBeNull();
  expect(document.body.textContent).not.toContain(secret);
  expect(document.querySelector(`input[value="${secret}"]`)).toBeNull();
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(secret);
}

it("offers an accessible login without a token or protected content", () => {
  render(<App />);
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(listKeys).not.toHaveBeenCalled();
});

it("submits by keyboard, verifies identity, stores only JWT and logs out", async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ token, user: { ...user, username: "untrusted-login-name" } }))
    .mockResolvedValueOnce(Response.json({ user }));
  render(<App />);
  await submitLogin();
  expect(await screen.findByText(user.username)).toBeDefined();
  expect(screen.queryByText("untrusted-login-name")).toBeNull();
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
    username: "demo",
    password: "demo-password",
  });
  expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/auth/me");
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(token);
  expect(localStorage.length).toBe(0);
  expect(location.pathname).toBe("/");
  expect(screen.getByRole("heading", { name: "Overview" })).toBeDefined();
  const keyboard = userEvent.setup();
  screen.getByRole("button", { name: "Log out" }).focus();
  await keyboard.keyboard("{Enter}");
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(screen.queryByText(user.username)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(location.pathname).toBe("/");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("shows a generic credential error and persists nothing on 401", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ error: "private detail" }, { status: 401 }));
  render(<App />);
  await submitLogin();
  expect((await screen.findByRole("alert")).textContent).toMatch(/username or password/i);
  expect(screen.queryByText("private detail")).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
});

it("unmounts the form to prevent duplicate submissions while signing in", async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  render(<App />);
  await submitLogin();
  expect(screen.getByRole("status").textContent).toBe("Checking session…");
  expect(screen.queryByLabelText("Username")).toBeNull();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.queryByText(user.username)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(Response.json({}, { status: 503 })));
  expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/i);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(sessionStorage.length).toBe(0);
});

it("revalidates restored tokens before rendering protected content", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  render(<App />);
  expect(screen.getByRole("status").textContent).toBe("Checking session…");
  expect(screen.queryByText(user.username)).toBeNull();
  expect(screen.queryByLabelText("Username")).toBeNull();
  expect(listKeys).not.toHaveBeenCalled();
  expect(getUsage).not.toHaveBeenCalled();
  await act(async () => pending.resolve(Response.json({ user })));
  expect(await screen.findByText(user.username)).toBeDefined();
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${token}` });
  expect(screen.getByRole("heading", { name: "Overview" })).toBeDefined();
});

it("clears rejected restored tokens and returns to login", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
  render(<App />);
  expect(await screen.findByLabelText("Username")).toBeDefined();
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByText(user.username)).toBeNull();
  expect(listKeys).not.toHaveBeenCalled();
});

it.each(["network", "server"])("blocks protected content on %s failure without retrying", async (kind) => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  if (kind === "network") fetchMock.mockRejectedValueOnce(new TypeError("private details"));
  else fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  render(<App />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/i);
  expect(screen.queryByText("private details")).toBeNull();
  expect(screen.queryByText(user.username)).toBeNull();
  expect(screen.queryByLabelText("Username")).toBeNull();
  expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(token);
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await userEvent.setup().click(screen.getByRole("button", { name: "Log out" }));
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(sessionStorage.length).toBe(0);
});

it("does not persist a login token when identity verification rejects it", async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ token, user }))
    .mockResolvedValueOnce(Response.json({}, { status: 401 }));
  render(<App />);
  await submitLogin();
  await screen.findByRole("alert");
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByText(user.username)).toBeNull();
  expect(listKeys).not.toHaveBeenCalled();
});

it("keeps login available without protected content if storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<App />);
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["/", "/login", "/portal"])("leaves anonymous %s visits at their original pathname", (path) => {
  history.replaceState(null, "", path);
  render(<App />);
  expect(location.pathname).toBe(path);
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["network", "server"])("recovers from %s only on manual retry", async (kind) => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  if (kind === "network") fetchMock.mockRejectedValueOnce(new TypeError("offline"));
  else fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  render(<App />);
  await screen.findByRole("alert");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce(Response.json({ user }));
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(user.username)).toBeDefined();
  expect(screen.getByRole("heading", { name: "Overview" })).toBeDefined();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("switches sidebar tabs without changing pathname and resets to Overview on reload", async () => {
  history.replaceState(null, "", "/portal");
  const { unmount } = await restore();
  const keyboard = userEvent.setup();
  for (const view of ["API keys", "Usage", "Overview"]) {
    await keyboard.click(screen.getByRole("button", { name: view }));
    expect(screen.getByRole("heading", { name: view })).toBeDefined();
    expect(location.pathname).toBe("/portal");
  }
  await keyboard.click(screen.getByRole("button", { name: "Usage" }));
  unmount();
  fetchMock.mockResolvedValueOnce(Response.json({ user }));
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Overview" })).toBeDefined();
  expect(location.pathname).toBe("/portal");
});

it("renders server-derived Overview counts and its key-management action", async () => {
  vi.mocked(summarizeKeys).mockResolvedValue({ active: 7, revoked: 3, lastUsedAt: null, lastPrefix: null });
  await restore();
  expect(await screen.findByText("7", { exact: true })).toBeDefined();
  expect(screen.getByText("3", { exact: true })).toBeDefined();
  expect(screen.getByText("Active", { exact: true })).toBeDefined();
  expect(screen.getByText("Revoked", { exact: true })).toBeDefined();
  const keyboard = userEvent.setup();
  await keyboard.click(screen.getByRole("button", { name: "View usage" }));
  expect(screen.getByRole("heading", { name: "Usage" })).toBeDefined();
  await keyboard.click(screen.getByRole("button", { name: "Overview" }));
  await keyboard.click(screen.getByRole("button", { name: "Manage keys" }));
  expect(screen.getByRole("heading", { name: "API keys" })).toBeDefined();
  await openCreate();
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(createKey).not.toHaveBeenCalled();
});

it("creates through the real provider, re-pulls keys and summary, and reveals the secret only once", async () => {
  await restore();
  const keyReads = vi.mocked(listKeys).mock.calls.length;
  const summaryReads = vi.mocked(summarizeKeys).mock.calls.length;
  vi.mocked(listKeys).mockResolvedValue({ ...emptyPage, data: [key] });
  vi.mocked(summarizeKeys).mockResolvedValue({ active: 1, revoked: 0, lastUsedAt: null, lastPrefix: null });
  await revealKey();
  expect(createKey).toHaveBeenCalledExactlyOnceWith(token, ["search:read"]);
  expect(document.activeElement).toBe(screen.getByLabelText("New API key"));
  await waitFor(() => {
    expect(listKeys).toHaveBeenCalledTimes(keyReads + 1);
    expect(summarizeKeys).toHaveBeenCalledTimes(summaryReads + 1);
  });
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(token);
  expect(localStorage.length).toBe(0);
  await userEvent.setup().click(screen.getByRole("button", { name: "I've saved my key" }));
  expectNoSecret();
  await openCreate();
  expectNoSecret();
  expect(createKey).toHaveBeenCalledTimes(1);
});

it.each(["Cancel", "Escape"])("closes an unsubmitted create modal with %s", async (method) => {
  await restore();
  await openCreate();
  const keyboard = userEvent.setup();
  if (method === "Escape") await keyboard.keyboard("{Escape}");
  else await keyboard.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(createKey).not.toHaveBeenCalled();
});

it.each(["logout", "view change", "Escape", "bfcache"])(
  "clears a revealed key on %s and never persists it",
  async (transition) => {
    await restore();
    await revealKey();
    const keyboard = userEvent.setup();
    if (transition === "logout") {
      await keyboard.click(screen.getByRole("button", { name: "Log out" }));
      expect(screen.getByLabelText("Username")).toBeDefined();
      expect(sessionStorage.length).toBe(0);
    } else if (transition === "view change") {
      await keyboard.click(screen.getByRole("button", { name: "Usage" }));
    } else if (transition === "Escape") {
      await keyboard.keyboard("{Escape}");
    } else {
      fetchMock.mockResolvedValueOnce(Response.json({ user }));
      act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      await screen.findByText(user.username);
    }
    expectNoSecret();
    if (transition !== "logout") {
      if (transition === "view change") {
        await keyboard.click(screen.getByRole("button", { name: "Overview" }));
      }
      await openCreate();
      expectNoSecret();
    }
  },
);

it.each(["close", "logout"])("suppresses a late created secret after %s", async (transition) => {
  const pending = deferred<Awaited<ReturnType<typeof createKey>>>();
  vi.mocked(createKey).mockReturnValueOnce(pending.promise);
  await restore();
  const dialog = await openCreate();
  const keyboard = userEvent.setup();
  await keyboard.click(within(dialog).getByRole("checkbox", { name: /search:read/ }));
  await keyboard.click(within(dialog).getByRole("button", { name: "Create key" }));
  expect(createKey).toHaveBeenCalledTimes(1);
  const keyReads = vi.mocked(listKeys).mock.calls.length;
  const summaryReads = vi.mocked(summarizeKeys).mock.calls.length;
  if (transition === "logout") {
    await keyboard.click(screen.getByRole("button", { name: "Log out" }));
  } else {
    await keyboard.keyboard("{Escape}");
    // A response for the closed modal must not populate a newly opened one.
    await openCreate();
  }
  await act(async () => pending.resolve({ data: key, secret }));
  expectNoSecret();
  expect(listKeys).toHaveBeenCalledTimes(keyReads + (transition === "close" ? 1 : 0));
  expect(summarizeKeys).toHaveBeenCalledTimes(summaryReads + (transition === "close" ? 1 : 0));
  if (transition === "logout") {
    expect(screen.getByLabelText("Username")).toBeDefined();
    expect(sessionStorage.length).toBe(0);
  } else {
    expect(screen.getByRole("dialog", { name: "Create an API key" })).toBeDefined();
  }
});

it("confirms revocation, re-pulls keys and summary, and announces success", async () => {
  vi.mocked(listKeys).mockResolvedValue({ ...emptyPage, data: [key] });
  await restore();
  const keyboard = userEvent.setup();
  await keyboard.click(screen.getByRole("button", { name: "API keys" }));
  await keyboard.click(await screen.findByRole("button", { name: `Revoke ${key.prefix}` }));
  const dialog = screen.getByRole("alertdialog", { name: "Revoke API key" });
  expect(within(dialog).getByRole("heading", { name: "Revoke API key" })).toBeDefined();
  expect(revokeKey).not.toHaveBeenCalled();
  const keyReads = vi.mocked(listKeys).mock.calls.length;
  const summaryReads = vi.mocked(summarizeKeys).mock.calls.length;
  vi.mocked(listKeys).mockResolvedValue({ ...emptyPage, data: [{ ...key, revoked_at: "2026-06-01T00:00:00.000Z" }] });
  vi.mocked(summarizeKeys).mockResolvedValue({ active: 0, revoked: 1, lastUsedAt: null, lastPrefix: null });
  await keyboard.click(within(dialog).getByRole("button", { name: "Revoke key" }));
  expect(revokeKey).toHaveBeenCalledExactlyOnceWith(token, key.id);
  await waitFor(() => {
    expect(listKeys).toHaveBeenCalledTimes(keyReads + 1);
    expect(summarizeKeys).toHaveBeenCalledTimes(summaryReads + 1);
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByText(`API key ${key.prefix} revoked.`)).toBeDefined();
  expect((screen.getByRole("button", { name: "Already revoked" }) as HTMLButtonElement).disabled).toBe(true);
});

it("paginates and refreshes keys using server pagination, including an empty page", async () => {
  vi.mocked(listKeys).mockResolvedValue({ ...emptyPage, data: [key], has_more: true });
  await restore();
  const keyboard = userEvent.setup();
  await keyboard.click(screen.getByRole("button", { name: "API keys" }));
  expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(listKeys).mockResolvedValueOnce({ ...emptyPage, offset: 20 });
  await keyboard.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("No keys on this page")).toBeDefined();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "API keys" }));
  expect(listKeys).toHaveBeenLastCalledWith(token, { limit: 20, offset: 20 });
  expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(listKeys).mockResolvedValueOnce(emptyPage);
  await keyboard.click(screen.getByRole("button", { name: "Previous" }));
  expect(await screen.findByText("No API keys yet")).toBeDefined();
  expect(listKeys).toHaveBeenLastCalledWith(token, { limit: 20, offset: 0 });
  vi.mocked(listKeys).mockResolvedValueOnce({ ...emptyPage, data: [key] });
  await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  expect(await screen.findByRole("button", { name: `Revoke ${key.prefix}` })).toBeDefined();
  expect(listKeys).toHaveBeenLastCalledWith(token, { limit: 20, offset: 0 });
});

it("refreshes usage, hides failed reads rather than assuming zero, and recovers an exhausted quota", async () => {
  await restore();
  const keyboard = userEvent.setup();
  await keyboard.click(screen.getByRole("button", { name: "Usage" }));
  const meter = await screen.findByRole("progressbar", { name: "Monthly quota used" });
  expect(meter.getAttribute("aria-valuenow")).toBe("127");
  expect(screen.getByText("873", { exact: true })).toBeDefined();
  vi.mocked(getUsage).mockRejectedValueOnce(new PortalError("network"));
  await keyboard.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/usage unavailable/i);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("873", { exact: true })).toBeNull();
  vi.mocked(getUsage).mockResolvedValueOnce({ data: { ...usage.data, billable_calls: 1000, remaining: 0 } });
  await keyboard.click(screen.getByRole("button", { name: "Retry usage" }));
  expect(await screen.findByText(/monthly quota exhausted/i)).toBeDefined();
  expect(screen.getByRole("progressbar", { name: "Monthly quota used" }).getAttribute("aria-valuenow")).toBe("1000");
  expect(getUsage).toHaveBeenLastCalledWith(token);
  await keyboard.click(screen.getByRole("button", { name: "API keys" }));
  expect(screen.getByRole("button", { name: "Create API key" })).toBeDefined();
});

it("revalidates a back-forward cache restoration and clears a rejected session", async () => {
  await restore();
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  expect(screen.queryByText(user.username)).toBeNull();
  expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Checking session…");
  await act(async () => pending.resolve(Response.json({}, { status: 401 })));
  await screen.findByLabelText("Username");
  expect(sessionStorage.length).toBe(0);
  expect(location.pathname).toBe("/");
});

it("does not revalidate ordinary pageshow events", async () => {
  await restore();
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
  expect(screen.getByText(user.username)).toBeDefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not restore a late identity after bfcache revalidation and logout", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  render(<App />);
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await screen.findByRole("alert");
  await userEvent.setup().click(screen.getByRole("button", { name: "Log out" }));
  await act(async () => pending.resolve(Response.json({ user })));
  expect(screen.queryByText(user.username)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(screen.getByLabelText("Username")).toBeDefined();
});

it("ignores a login response superseded by bfcache session restoration", async () => {
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  render(<App />);
  await submitLogin();
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await act(async () => pending.resolve(Response.json({ token, user })));
  expect(screen.queryByText(user.username)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Username")).toBeDefined();
});

it("ignores a restored identity response after unmount", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  const { unmount } = render(<App />);
  unmount();
  sessionStorage.clear();
  render(<App />);
  await act(async () => pending.resolve(Response.json({ user })));
  await waitFor(() => expect(screen.getByLabelText("Username")).toBeDefined());
  expect(screen.queryByText(user.username)).toBeNull();
  expect(listKeys).not.toHaveBeenCalled();
});

it("logs out if a protected resource rejects the session", async () => {
  vi.mocked(getUsage).mockRejectedValueOnce(new PortalError("unauthenticated", 401));
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  fetchMock.mockResolvedValueOnce(Response.json({ user }));
  render(<App />);
  await screen.findByLabelText("Username");
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByText(user.username)).toBeNull();
});
