import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "../src/app";
import * as auth from "../src/auth";
import { getUsage, listKeys, type OwnerUsage, PortalError, summarizeKeys } from "../src/portal-api";
import { useAppActions, useAppState } from "../src/state/context";
import { PortalProvider } from "../src/state/portal-provider";
import { UsageView } from "../src/usage";

vi.mock("../src/auth", async (original) => ({
  ...(await original<typeof import("../src/auth")>()),
  readToken: vi.fn(),
  getIdentity: vi.fn(),
  login: vi.fn(),
  storeToken: vi.fn(),
  clearToken: vi.fn(),
}));
vi.mock("../src/portal-api", async (original) => ({
  ...(await original<typeof import("../src/portal-api")>()),
  getUsage: vi.fn(),
  listKeys: vi.fn(),
  summarizeKeys: vi.fn(),
}));

const user = { id: "owner-1", username: "demo" };
const january: OwnerUsage = {
  data: {
    period_start: "2026-01-01T00:00:00.000Z",
    period_end: "2026-02-01T00:00:00.000Z",
    billable_calls: 127,
    quota: 1000,
    remaining: 873,
  },
};

// Keep the real provider/session lifecycle while focusing most cases on UsageView.
function UsagePortal() {
  const { session } = useAppState();
  const { signIn, signOut } = useAppActions();
  return (
    <>
      <output data-testid="session">{session.status}</output>
      {session.status === "authenticated" ? (
        <>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
          <UsageView />
        </>
      ) : (
        <button type="button" onClick={() => void signIn({ username: "demo", password: "pw" })}>
          Sign in
        </button>
      )}
    </>
  );
}

function mount() {
  return render(
    <PortalProvider>
      <UsagePortal />
    </PortalProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function expectUsage(data: OwnerUsage["data"]) {
  const progress = screen.getByRole("progressbar", { name: "Monthly quota used" });
  expect(progress.getAttribute("aria-valuenow")).toBe(String(data.billable_calls));
  expect(progress.getAttribute("aria-valuemax")).toBe(String(data.quota));
  expect(screen.getByText("Remaining").parentElement?.textContent).toBe(`Remaining${data.remaining.toLocaleString()}`);
  expect(screen.getByText(data.period_start)).toBeDefined();
  expect(document.querySelector(`time[datetime="${data.period_end}"]`)).not.toBeNull();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.readToken).mockReturnValue("session-one");
  vi.mocked(auth.getIdentity).mockResolvedValue({ user });
  vi.mocked(auth.login).mockResolvedValue({ token: "session-two", user });
  vi.mocked(getUsage).mockResolvedValue(january);
  vi.mocked(listKeys).mockResolvedValue({ data: [], limit: 20, offset: 0, has_more: false });
  vi.mocked(summarizeKeys).mockResolvedValue({ active: 0, revoked: 0, lastUsedAt: null, lastPrefix: null });
});
afterEach(cleanup);

it("loads authoritative values and explicitly refreshes into the next UTC period", async () => {
  const pending = deferred<OwnerUsage>();
  vi.mocked(getUsage).mockReturnValueOnce(pending.promise);
  mount();
  expect(await screen.findByText("Loading usage…")).toBeDefined();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("873")).toBeNull();
  await act(async () => pending.resolve(january));
  expectUsage(january.data);
  expect(getUsage).toHaveBeenCalledWith("session-one");

  const february = {
    ...january.data,
    period_start: january.data.period_end,
    period_end: "2026-03-01T00:00:00.000Z",
    billable_calls: 0,
    remaining: 1000,
  };
  const refresh = deferred<OwnerUsage>();
  vi.mocked(getUsage).mockReturnValueOnce(refresh.promise);
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(screen.getByText("Loading usage…")).toBeDefined();
  expect(screen.queryByRole("progressbar")).toBeNull();
  await act(async () => refresh.resolve({ data: february }));
  expectUsage(february);
  expect(screen.queryByText(january.data.period_start)).toBeNull();
  expect(getUsage).toHaveBeenCalledTimes(2);
  expect(getUsage).toHaveBeenLastCalledWith("session-one");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh usage" }));
});

it.each(["network", "server", "invalid_response"] as const)(
  "hides old values after a %s refresh failure and retries the authoritative read",
  async (kind) => {
    mount();
    await screen.findByRole("progressbar");
    vi.mocked(getUsage).mockRejectedValueOnce(new PortalError(kind));
    const keyboard = userEvent.setup();
    await keyboard.click(screen.getByRole("button", { name: "Refresh usage" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/usage unavailable/i);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("873")).toBeNull();
    expect(screen.queryByText(january.data.period_start)).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    expect(auth.clearToken).not.toHaveBeenCalled();

    await keyboard.click(screen.getByRole("button", { name: "Retry usage" }));
    await screen.findByRole("progressbar");
    expectUsage(january.data);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getUsage).toHaveBeenCalledTimes(3);
    expect(getUsage).toHaveBeenLastCalledWith("session-one");
  },
);

it("keeps usage reads and key management available when the authoritative quota is exhausted", async () => {
  vi.mocked(getUsage).mockResolvedValue({ data: { ...january.data, billable_calls: 1000, remaining: 0 } });
  render(<App />);
  const keyboard = userEvent.setup();
  await keyboard.click(await screen.findByRole("button", { name: "Usage" }));
  expect(screen.getByText(/quota exhausted.*key management.*remain available/i)).toBeDefined();
  await keyboard.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(getUsage).toHaveBeenCalledTimes(2);
  await keyboard.click(screen.getByRole("button", { name: "API keys" }));
  await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  expect(listKeys).toHaveBeenCalledTimes(2);
  await keyboard.click(screen.getByRole("button", { name: "Create API key" }));
  expect(await screen.findByRole("dialog", { name: "Create an API key" })).toBeDefined();
});

it("signs out and forgets the token on an authoritative usage 401", async () => {
  mount();
  await screen.findByRole("progressbar");
  vi.mocked(getUsage).mockRejectedValueOnce(new PortalError("unauthenticated", 401));
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh usage" }));
  await waitFor(() => expect(screen.getByTestId("session").textContent).toBe("anonymous"));
  expect(auth.clearToken).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["success", "401", "failure"] as const)("ignores stale usage %s after a new sign-in", async (outcome) => {
  const old = deferred<OwnerUsage>();
  vi.mocked(getUsage).mockReturnValueOnce(old.promise);
  mount();
  await screen.findByText("Loading usage…");
  const keyboard = userEvent.setup();
  await keyboard.click(screen.getByRole("button", { name: "Sign out" }));
  await keyboard.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("progressbar");
  expect(getUsage).toHaveBeenLastCalledWith("session-two");
  expect(auth.storeToken).toHaveBeenCalledWith("session-two");
  vi.mocked(auth.clearToken).mockClear();

  await act(async () => {
    if (outcome === "success") old.resolve({ data: { ...january.data, billable_calls: 999, remaining: 1 } });
    else {
      old.reject(new PortalError(outcome === "401" ? "unauthenticated" : "server", outcome === "401" ? 401 : 500));
    }
  });
  expectUsage(january.data);
  expect(screen.getByTestId("session").textContent).toBe("authenticated");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(auth.clearToken).not.toHaveBeenCalled();
});

// The provider suite already covers late 401s from every resource on unmount.
it.each(["success", "failure"] as const)("ignores a pending usage refresh %s after unmount", async (outcome) => {
  const view = mount();
  await screen.findByRole("progressbar");
  const late = deferred<OwnerUsage>();
  vi.mocked(getUsage).mockReturnValueOnce(late.promise);
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh usage" }));
  view.unmount();
  await act(async () => {
    if (outcome === "success") late.resolve(january);
    else late.reject(new PortalError("server"));
  });
  expect(auth.clearToken).not.toHaveBeenCalled();
  expect(within(document.body).queryByRole("progressbar")).toBeNull();
  expect(within(document.body).queryByRole("alert")).toBeNull();
});
