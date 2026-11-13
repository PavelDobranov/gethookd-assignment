import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AppActionsContext, AppStateContext } from "./state/context";
import type { AppActions, AppState } from "./state/types";
import { initialState } from "./state/types";
import { UsageView } from "./usage";

afterEach(cleanup);

function show(usage: AppState["usage"]) {
  const loadUsage = vi.fn(async () => {});
  render(
    <AppActionsContext.Provider value={{ loadUsage } as unknown as AppActions}>
      <AppStateContext.Provider value={{ ...initialState, usage }}>
        <UsageView />
      </AppStateContext.Provider>
    </AppActionsContext.Provider>,
  );
  return loadUsage;
}

const data = {
  period_start: "2026-06-01T00:00:00.000Z",
  period_end: "2026-07-01T00:00:00.000Z",
  billable_calls: 127,
  quota: 1000,
  remaining: 873,
};

it("renders authoritative quota values and refreshes through context", async () => {
  const refresh = show({ status: "ready", data });
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("127");
  expect(screen.getByText("873")).toBeDefined();
  expect(screen.getByText("Resets")).toBeDefined();
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(refresh).toHaveBeenCalledOnce();
});

it("shows exhaustion only when the server reports zero remaining", () => {
  show({ status: "ready", data: { ...data, remaining: 0, billable_calls: 1000 } });
  expect(screen.getByText(/Monthly quota exhausted/)).toBeDefined();
});

it("does not present a stale usage value as current on failure", async () => {
  const retry = show({ status: "error", data });
  expect(screen.getByRole("alert").textContent).toMatch(/Usage unavailable/);
  expect(screen.queryByRole("progressbar")).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry usage" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("announces loading and disables refresh", () => {
  show({ status: "loading", data: null });
  expect(screen.getByRole("status").textContent).toMatch(/Loading usage/);
  expect((screen.getByRole("button", { name: "Refresh usage" }) as HTMLButtonElement).disabled).toBe(true);
});
