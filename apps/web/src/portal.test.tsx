import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Portal } from "./portal";
import * as api from "./portal-api";
import { type CreatedKey, type KeyList, type KeyMetadata, PortalError } from "./portal-api";

vi.mock("./portal-api", async (original) => ({
  ...(await original<typeof api>()),
  listKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  getUsage: vi.fn(),
}));
const metadata: KeyMetadata = {
  id: "key-id",
  prefix: "ghk_public12",
  scopes: ["search:read"],
  created_at: "2026-01-01T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};
const secret = "ghk_reveal_only_in_memory";
const empty: KeyList = { data: [], limit: 20, offset: 0, has_more: false };
const logout = vi.fn();
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function mount() {
  return render(<Portal token="session-one" userId="owner-one" onUnauthenticated={logout} />);
}
async function selectAndCreate() {
  const keyboard = userEvent.setup();
  await keyboard.click(screen.getByLabelText("search:read"));
  await keyboard.click(screen.getByRole("button", { name: "Create key" }));
  return keyboard;
}
beforeEach(() => {
  vi.mocked(api.listKeys).mockResolvedValue(empty);
  vi.mocked(api.getUsage).mockResolvedValue({
    data: {
      period_start: "2026-06-01T00:00:00.000Z",
      period_end: "2026-07-01T00:00:00.000Z",
      billable_calls: 127,
      quota: 1000,
      remaining: 873,
    },
  });
  vi.mocked(api.createKey).mockResolvedValue({ data: metadata, secret });
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("requires explicit scopes, prevents repeated submission, reveals once and refreshes metadata", async () => {
  const pending = deferred<CreatedKey>();
  vi.mocked(api.createKey).mockReturnValueOnce(pending.promise);
  mount();
  expect((screen.getByRole("button", { name: "Create key" }) as HTMLButtonElement).disabled).toBe(true);
  const keyboard = await selectAndCreate();
  expect(api.createKey).toHaveBeenCalledWith("session-one", ["search:read"]);
  await keyboard.click(screen.getByRole("button", { name: "Creating…" }));
  expect(api.createKey).toHaveBeenCalledTimes(1);
  vi.mocked(api.listKeys).mockResolvedValue({ ...empty, data: [metadata] });
  await act(async () => pending.resolve({ data: metadata, secret }));
  expect((screen.getByLabelText("New API key") as HTMLInputElement).value).toBe(secret);
  expect(await screen.findByText(metadata.prefix)).toBeDefined();
  expect(screen.getByText("Never used")).toBeDefined();
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
  await keyboard.click(screen.getByRole("button", { name: "Dismiss secret" }));
  expect(screen.queryByLabelText("New API key")).toBeNull();
  expect((screen.getByRole("button", { name: "Create key" }) as HTMLButtonElement).disabled).toBe(false);
});

it("supports both scopes and keyboard submission", async () => {
  mount();
  const keyboard = userEvent.setup();
  screen.getByLabelText("search:read").focus();
  await keyboard.keyboard(" ");
  await keyboard.tab();
  await keyboard.keyboard(" ");
  await keyboard.tab();
  await keyboard.keyboard("{Enter}");
  await screen.findByLabelText("New API key");
  expect(api.createKey).toHaveBeenCalledWith("session-one", ["search:read", "keys:manage"]);
});

it.each(["success", "rejected", "unavailable"])("handles clipboard %s with selectable fallback", async (kind) => {
  const keyboard = userEvent.setup();
  const copy = vi
    .fn()
    .mockImplementation(() => (kind === "success" ? Promise.resolve() : Promise.reject(new Error("private"))));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: kind === "unavailable" ? undefined : { writeText: copy },
  });
  mount();
  await keyboard.click(screen.getByLabelText("keys:manage"));
  await keyboard.click(screen.getByRole("button", { name: "Create key" }));
  await screen.findByLabelText("New API key");
  await keyboard.click(screen.getByRole("button", { name: "Copy secret" }));
  expect(
    await screen.findByText(
      kind === "success" ? "Secret copied." : "Copy unavailable. Select and copy the key manually.",
    ),
  ).toBeDefined();
  const input = screen.getByLabelText("New API key") as HTMLInputElement;
  input.focus();
  await keyboard.keyboard("{Control>}a{/Control}");
  expect(input.selectionEnd).toBe(secret.length);
  if (kind !== "unavailable") expect(copy).toHaveBeenCalledWith(secret);
});

it("does not let late clipboard feedback restore a dismissed secret", async () => {
  const keyboard = userEvent.setup();
  const pending = deferred<void>();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => pending.promise } });
  mount();
  await keyboard.click(screen.getByLabelText("search:read"));
  await keyboard.click(screen.getByRole("button", { name: "Create key" }));
  await screen.findByLabelText("New API key");
  await keyboard.click(screen.getByRole("button", { name: "Copy secret" }));
  await keyboard.click(screen.getByRole("button", { name: "Dismiss secret" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Create key" }));
  await act(async () => pending.resolve());
  expect(screen.queryByLabelText("New API key")).toBeNull();
  expect(screen.queryByText("Secret copied.")).toBeNull();
});

it("explains unknown creation outcomes without retrying and permits explicit recovery", async () => {
  vi.mocked(api.createKey).mockRejectedValue(new PortalError("network", undefined, undefined, true));
  mount();
  await selectAndCreate();
  expect((await screen.findByRole("alert")).textContent).toMatch(/secret cannot be recovered.*revoke.*orphaned/i);
  expect(api.createKey).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("New API key")).toBeNull();
});

it("paginates, refreshes, displays dates and handles loading, empty and failed reads", async () => {
  const pending = deferred<KeyList>();
  vi.mocked(api.listKeys).mockReturnValueOnce(pending.promise);
  mount();
  expect(screen.getByText("Loading keys…")).toBeDefined();
  await act(async () => pending.resolve({ ...empty, data: [metadata], has_more: true }));
  const keyboard = userEvent.setup();
  vi.mocked(api.listKeys).mockResolvedValueOnce({
    ...empty,
    offset: 20,
    data: [{ ...metadata, prefix: "second-page", last_used_at: metadata.created_at, revoked_at: metadata.created_at }],
  });
  await keyboard.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByText("second-page")).toBeDefined();
  expect(api.listKeys).toHaveBeenLastCalledWith("session-one", { offset: 20 });
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your API keys" }));
  expect(screen.getByText("Revoked")).toBeDefined();
  expect(screen.getAllByText(metadata.created_at)).toHaveLength(3);
  vi.mocked(api.listKeys).mockRejectedValueOnce(new PortalError("server"));
  await keyboard.click(screen.getByRole("button", { name: "Previous page" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not complete/i);
  expect(screen.queryByText("second-page")).toBeNull();
  await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  expect(await screen.findByText("No keys on this page.")).toBeDefined();
  expect(logout).not.toHaveBeenCalled();
});

it.each(["list", "create"])("clears authentication only on authoritative %s JWT401", async (operation) => {
  if (operation === "list") vi.mocked(api.listKeys).mockRejectedValueOnce(new PortalError("unauthenticated"));
  else vi.mocked(api.createKey).mockRejectedValueOnce(new PortalError("unauthenticated"));
  mount();
  if (operation === "create") await selectAndCreate();
  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
});

it.each(["unmount", "user", "token"])("ignores late metadata and creation after %s changes", async (change) => {
  const list = deferred<KeyList>();
  const created = deferred<CreatedKey>();
  vi.mocked(api.listKeys).mockReturnValueOnce(list.promise);
  vi.mocked(api.createKey).mockReturnValueOnce(created.promise);
  const view = mount();
  await selectAndCreate();
  if (change === "unmount") {
    view.unmount();
    mount();
  } else
    view.rerender(
      <Portal
        token={change === "token" ? "session-two" : "session-one"}
        userId={change === "user" ? "owner-two" : "owner-one"}
        onUnauthenticated={logout}
      />,
    );
  await act(async () => {
    list.resolve({ ...empty, data: [metadata] });
    created.resolve({ data: metadata, secret });
  });
  expect(screen.queryByLabelText("New API key")).toBeNull();
  expect(screen.queryByText(metadata.prefix)).toBeNull();
});

it("confirms permanent revocation, cancels without a request, and refreshes only after success", async () => {
  vi.mocked(api.listKeys).mockResolvedValue({ ...empty, data: [metadata] });
  const pending = deferred<void>();
  vi.mocked(api.revokeKey).mockReturnValueOnce(pending.promise);
  mount();
  const keyboard = userEvent.setup();
  await keyboard.click(await screen.findByRole("button", { name: `Revoke ${metadata.prefix}` }));
  expect(screen.getByText(/Revocation is permanent/)).toBeDefined();
  await keyboard.click(screen.getByRole("button", { name: "Cancel revocation" }));
  expect(api.revokeKey).not.toHaveBeenCalled();
  screen.getByRole("button", { name: `Revoke ${metadata.prefix}` }).focus();
  await keyboard.keyboard("{Enter}");
  screen.getByRole("button", { name: "Confirm permanent revocation" }).focus();
  await keyboard.keyboard("{Enter}");
  expect(api.revokeKey).toHaveBeenCalledWith("session-one", metadata.id);
  expect(screen.getByText("Active")).toBeDefined();
  expect(screen.queryByText("Revoked")).toBeNull();
  await keyboard.click(screen.getByRole("button", { name: "Revoking…" }));
  expect(api.revokeKey).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Refresh keys" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Create key" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
  await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  expect(api.listKeys).toHaveBeenCalledTimes(1);
  vi.mocked(api.listKeys).mockResolvedValue({ ...empty, data: [{ ...metadata, revoked_at: metadata.created_at }] });
  await act(async () => pending.resolve());
  expect(await screen.findByText("Revoked")).toBeDefined();
  expect(screen.queryByRole("button", { name: `Revoke ${metadata.prefix}` })).toBeNull();
  expect(screen.queryByRole("button", { name: /reactivate/i })).toBeNull();
  expect(api.listKeys).toHaveBeenCalledTimes(2);
  expect(screen.getByText("127 / 1000")).toBeDefined();
  expect(api.getUsage).toHaveBeenCalledTimes(1);
});

it.each(["server", "network", "not_found"] as const)(
  "keeps %s revoke failures truthful and retryable",
  async (kind) => {
    vi.mocked(api.listKeys).mockResolvedValue({ ...empty, data: [metadata] });
    vi.mocked(api.revokeKey).mockRejectedValueOnce(new PortalError(kind));
    mount();
    const keyboard = userEvent.setup();
    await keyboard.click(await screen.findByRole("button", { name: `Revoke ${metadata.prefix}` }));
    await keyboard.click(screen.getByRole("button", { name: "Confirm permanent revocation" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Revocation was not confirmed/);
    expect(screen.getByText("Active")).toBeDefined();
    expect(api.listKeys).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    vi.mocked(api.revokeKey).mockResolvedValueOnce();
    vi.mocked(api.listKeys).mockRejectedValueOnce(new PortalError("server"));
    await keyboard.click(screen.getByRole("button", { name: "Confirm permanent revocation" }));
    expect(await screen.findByText(/Revocation confirmed/)).toBeDefined();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not complete/i);
    expect(screen.queryByText("Active")).toBeNull();
  },
);

it("preserves the selected page on revocation and refresh", async () => {
  vi.mocked(api.listKeys).mockResolvedValueOnce({ ...empty, data: [metadata], has_more: true });
  mount();
  const keyboard = userEvent.setup();
  await screen.findByText(metadata.prefix);
  vi.mocked(api.listKeys).mockResolvedValue({ ...empty, offset: 20, data: [metadata] });
  await keyboard.click(screen.getByRole("button", { name: "Next page" }));
  await keyboard.click(await screen.findByRole("button", { name: `Revoke ${metadata.prefix}` }));
  vi.mocked(api.revokeKey).mockResolvedValueOnce();
  vi.mocked(api.listKeys).mockResolvedValue({ ...empty, offset: 20 });
  await keyboard.click(screen.getByRole("button", { name: "Confirm permanent revocation" }));
  expect(await screen.findByText("No keys on this page.")).toBeDefined();
  expect(api.listKeys).toHaveBeenLastCalledWith("session-one", { offset: 20 });
  await keyboard.click(screen.getByRole("button", { name: "Previous page" }));
  await waitFor(() => expect(api.listKeys).toHaveBeenLastCalledWith("session-one", { offset: 0 }));
});

it("routes revoke JWT401 through the established logout callback", async () => {
  vi.mocked(api.listKeys).mockResolvedValue({ ...empty, data: [metadata] });
  vi.mocked(api.revokeKey).mockRejectedValueOnce(new PortalError("unauthenticated"));
  mount();
  const keyboard = userEvent.setup();
  await keyboard.click(await screen.findByRole("button", { name: `Revoke ${metadata.prefix}` }));
  await keyboard.click(screen.getByRole("button", { name: "Confirm permanent revocation" }));
  expect(logout).toHaveBeenCalledTimes(1);
});

it.each(["success", "unauthenticated"])("ignores late revoke %s after logout/unmount", async (outcome) => {
  vi.mocked(api.listKeys).mockResolvedValueOnce({ ...empty, data: [metadata] });
  const pending = deferred<void>();
  vi.mocked(api.revokeKey).mockReturnValueOnce(pending.promise);
  const view = mount();
  const keyboard = userEvent.setup();
  await keyboard.click(await screen.findByRole("button", { name: `Revoke ${metadata.prefix}` }));
  await keyboard.click(screen.getByRole("button", { name: "Confirm permanent revocation" }));
  view.unmount();
  mount();
  await act(async () => {
    if (outcome === "success") pending.resolve();
    else pending.reject(new PortalError("unauthenticated"));
  });
  expect(screen.queryByText(metadata.prefix)).toBeNull();
  expect(screen.queryByText(/Revocation confirmed/)).toBeNull();
  expect(logout).not.toHaveBeenCalled();
  expect(api.listKeys).toHaveBeenCalledTimes(2);
});

it("ignores stale JWT failures after an identity change", async () => {
  const pending = deferred<KeyList>();
  vi.mocked(api.listKeys).mockReturnValueOnce(pending.promise);
  const view = mount();
  view.rerender(<Portal token="session-two" userId="owner-two" onUnauthenticated={logout} />);
  await act(async () => pending.reject(new PortalError("unauthenticated")));
  expect(logout).not.toHaveBeenCalled();
});
