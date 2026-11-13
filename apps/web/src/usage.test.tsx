import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Usage } from "./legacy-usage";
import { getUsage, type OwnerUsage, PortalError } from "./portal-api";

vi.mock("./portal-api", async (original) => ({
  ...(await original<typeof import("./portal-api")>()),
  getUsage: vi.fn(),
}));
const january: OwnerUsage = {
  data: {
    period_start: "2026-01-01T00:00:00.000Z",
    period_end: "2026-02-01T00:00:00.000Z",
    billable_calls: 127,
    quota: 1000,
    remaining: 873,
  },
};
const logout = vi.fn();
function mount(token = "session-one") {
  return render(<Usage token={token} onUnauthenticated={logout} />);
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => vi.mocked(getUsage).mockResolvedValue(january));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("loads only server values and explicitly refreshes into a new UTC period", async () => {
  const pending = deferred<OwnerUsage>();
  vi.mocked(getUsage).mockReturnValueOnce(pending.promise);
  mount();
  expect(screen.getByText("Loading usage…")).toBeDefined();
  expect(screen.queryByText("0 / 1000")).toBeNull();
  await act(async () => pending.resolve(january));
  expect(screen.getByText("127 / 1000")).toBeDefined();
  expect(screen.getByText("873")).toBeDefined();
  expect(screen.getByText(january.data.period_start)).toBeDefined();
  expect(screen.getByText(january.data.period_end)).toBeDefined();
  expect(getUsage).toHaveBeenCalledWith("session-one");
  vi.mocked(getUsage).mockResolvedValueOnce({
    data: {
      ...january.data,
      period_start: january.data.period_end,
      period_end: "2026-03-01T00:00:00.000Z",
      billable_calls: 0,
      remaining: 1000,
    },
  });
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(await screen.findByText("0 / 1000")).toBeDefined();
  expect(screen.getByText("2026-03-01T00:00:00.000Z")).toBeDefined();
  expect(getUsage).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh usage" }));
});

it.each([new PortalError("network"), new PortalError("server"), new PortalError("invalid_response")])(
  "shows unavailable rather than fabricated zero after failed refresh: %s",
  async (failure) => {
    mount();
    await screen.findByText("127 / 1000");
    vi.mocked(getUsage).mockRejectedValueOnce(failure);
    const keyboard = userEvent.setup();
    await keyboard.click(screen.getByRole("button", { name: "Refresh usage" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/usage unavailable/i);
    expect(screen.queryByText("127 / 1000")).toBeNull();
    expect(screen.queryByText("0 / 1000")).toBeNull();
    await keyboard.click(screen.getByRole("button", { name: "Retry usage" }));
    expect(await screen.findByText("127 / 1000")).toBeDefined();
  },
);

it("explains exhausted quota without disabling free operations", async () => {
  vi.mocked(getUsage).mockResolvedValue({ data: { ...january.data, billable_calls: 1000, remaining: 0 } });
  mount();
  expect(await screen.findByText("1000 / 1000")).toBeDefined();
  expect(screen.getByText(/quota exhausted.*key management.*remain available/i)).toBeDefined();
  expect((screen.getByRole("button", { name: "Refresh usage" }) as HTMLButtonElement).disabled).toBe(false);
});

it("handles a live JWT 401 through the portal callback", async () => {
  vi.mocked(getUsage).mockRejectedValue(new PortalError("unauthenticated", 401));
  mount();
  await act(async () => {});
  expect(logout).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["success", "401", "failure"])("ignores stale %s after credential change and unmount", async (outcome) => {
  const old = deferred<OwnerUsage>();
  vi.mocked(getUsage).mockReturnValueOnce(old.promise);
  const view = mount();
  view.rerender(<Usage token="session-two" onUnauthenticated={logout} />);
  await screen.findByText("127 / 1000");
  await act(async () => {
    if (outcome === "success") old.resolve({ data: { ...january.data, billable_calls: 999, remaining: 1 } });
    else old.reject(new PortalError(outcome === "401" ? "unauthenticated" : "server"));
  });
  expect(screen.queryByText("999 / 1000")).toBeNull();
  expect(logout).not.toHaveBeenCalled();
  const late = deferred<OwnerUsage>();
  vi.mocked(getUsage).mockReturnValueOnce(late.promise);
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh usage" }));
  view.unmount();
  await act(async () => late.reject(new PortalError("unauthenticated")));
  expect(logout).not.toHaveBeenCalled();
  expect(within(document.body).queryByText("127 / 1000")).toBeNull();
});
