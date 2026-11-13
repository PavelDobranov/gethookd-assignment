import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "./app";
import * as auth from "./auth";
import * as api from "./portal-api";
import { type CreatedKey, type KeyMetadata, PortalError } from "./portal-api";

vi.mock("./auth", async (original) => ({
  ...(await original<typeof auth>()),
  readToken: vi.fn(),
  getIdentity: vi.fn(),
  clearToken: vi.fn(),
}));
vi.mock("./portal-api", async (original) => ({
  ...(await original<typeof api>()),
  listKeys: vi.fn(),
  summarizeKeys: vi.fn(),
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
const page = { data: [metadata], limit: 20, offset: 0, has_more: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount() {
  const view = render(<App />);
  await screen.findByRole("heading", { name: "Overview" });
  await userEvent.setup().click(screen.getByRole("button", { name: "API keys" }));
  await screen.findByRole("button", { name: `Revoke ${metadata.prefix}` });
  return view;
}
async function openCreate() {
  await userEvent.setup().click(screen.getByRole("button", { name: "Create API key" }));
  return screen.findByRole("dialog", { name: "Create an API key" });
}
async function selectAndCreate() {
  const dialog = await openCreate();
  const keyboard = userEvent.setup();
  await keyboard.click(within(dialog).getByRole("checkbox", { name: /search:read/ }));
  await keyboard.click(within(dialog).getByRole("button", { name: "Create key" }));
  return keyboard;
}
async function openRevoke() {
  await userEvent.setup().click(screen.getByRole("button", { name: `Revoke ${metadata.prefix}` }));
  return screen.getByRole("alertdialog", { name: "Revoke API key" });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.readToken).mockReturnValue("session-one");
  vi.mocked(auth.getIdentity).mockResolvedValue({ user: { id: "owner-one", username: "demo" } });
  vi.mocked(api.listKeys).mockResolvedValue(page);
  vi.mocked(api.summarizeKeys).mockResolvedValue({ active: 1, revoked: 0, lastUsedAt: null, lastPrefix: null });
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
  vi.mocked(api.revokeKey).mockResolvedValue(undefined);
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("requires explicit scopes and prevents repeated creation while pending", async () => {
  const pending = deferred<CreatedKey>();
  vi.mocked(api.createKey).mockReturnValueOnce(pending.promise);
  await mount();
  const dialog = await openCreate();
  const submit = within(dialog).getByRole("button", { name: "Create key" });
  expect(submit).toHaveProperty("disabled", true);
  const keyboard = userEvent.setup();
  await keyboard.click(submit);
  expect(api.createKey).not.toHaveBeenCalled();
  await keyboard.click(within(dialog).getByRole("checkbox", { name: /search:read/ }));
  await keyboard.click(submit);
  expect(submit).toHaveProperty("disabled", true);
  await keyboard.click(submit);
  expect(api.createKey).toHaveBeenCalledExactlyOnceWith("session-one", ["search:read"]);
  await act(async () => pending.resolve({ data: metadata, secret }));
  expect((screen.getByLabelText("New API key") as HTMLInputElement).value).toBe(secret);
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
});

it("supports both scopes, keyboard submission, and modal focus trapping/restoration", async () => {
  await mount();
  const opener = screen.getByRole("button", { name: "Create API key" });
  const dialog = await openCreate();
  const keyboard = userEvent.setup();
  const search = within(dialog).getByRole("checkbox", { name: /search:read/ });
  expect(document.activeElement).toBe(search);
  await keyboard.tab({ shift: true });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  await keyboard.tab();
  expect(document.activeElement).toBe(search);
  await keyboard.keyboard(" ");
  await keyboard.tab();
  await keyboard.keyboard(" ");
  await keyboard.tab();
  await keyboard.tab();
  const submit = within(dialog).getByRole("button", { name: "Create key" });
  expect(document.activeElement).toBe(submit);
  await keyboard.tab();
  expect(document.activeElement).toBe(search);
  submit.focus();
  await keyboard.keyboard("{Enter}");
  await screen.findByLabelText("New API key");
  expect(api.createKey).toHaveBeenCalledExactlyOnceWith("session-one", ["search:read", "keys:manage"]);
  await keyboard.click(screen.getByRole("button", { name: "I've saved my key" }));
  expect(document.activeElement).toBe(opener);
  expect(screen.queryByLabelText("New API key")).toBeNull();
});

it.each(["success", "rejected", "unavailable"])("handles clipboard %s with selectable fallback", async (kind) => {
  await mount();
  const keyboard = await selectAndCreate();
  await screen.findByLabelText("New API key");
  const copy = vi.fn(() => (kind === "success" ? Promise.resolve() : Promise.reject(new Error("private"))));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: kind === "unavailable" ? undefined : { writeText: copy },
  });
  await keyboard.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText(kind === "success" ? /Copied to clipboard/ : /copy it manually/)).toBeDefined();
  const input = screen.getByLabelText("New API key") as HTMLInputElement;
  if (kind !== "success") {
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(secret.length);
  }
  input.focus();
  await keyboard.keyboard("{Control>}a{/Control}");
  expect(input.selectionEnd).toBe(secret.length);
  if (kind !== "unavailable") expect(copy).toHaveBeenCalledWith(secret);
});

it("does not let late clipboard feedback restore a dismissed secret or affect a new modal", async () => {
  await mount();
  const keyboard = await selectAndCreate();
  await screen.findByLabelText("New API key");
  const pending = deferred<void>();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => pending.promise } });
  await keyboard.click(screen.getByRole("button", { name: "Copy" }));
  await keyboard.click(screen.getByRole("button", { name: "I've saved my key" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Create API key" }));
  await openCreate();
  await act(async () => pending.resolve());
  expect(screen.queryByLabelText("New API key")).toBeNull();
  expect(screen.queryByText(/Copied to clipboard/)).toBeNull();
});

it("explains unknown creation outcomes without retrying and permits explicit recovery", async () => {
  vi.mocked(api.createKey).mockRejectedValueOnce(new PortalError("network", undefined, undefined, true));
  await mount();
  const keyboard = await selectAndCreate();
  expect((await screen.findByRole("alert")).textContent).toMatch(/secret cannot be recovered.*revoke.*orphaned/i);
  expect(api.createKey).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("New API key")).toBeNull();
  await keyboard.click(screen.getByRole("button", { name: "Create key" }));
  await screen.findByLabelText("New API key");
  expect(api.createKey).toHaveBeenCalledTimes(2);
});

it("hides stale keys on failed reads and recovers only on explicit refresh", async () => {
  await mount();
  vi.mocked(api.listKeys).mockRejectedValueOnce(new PortalError("server"));
  const keyboard = userEvent.setup();
  await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not complete/i);
  expect(screen.queryByRole("table")).toBeNull();
  expect(auth.clearToken).not.toHaveBeenCalled();
  await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  expect(await screen.findByRole("table")).toBeDefined();
});

it("cancels permanent revocation without a request and blocks repeat submission until confirmation", async () => {
  await mount();
  const keyboard = userEvent.setup();
  let dialog = await openRevoke();
  expect(within(dialog).getByText(/Revocation is permanent and cannot be undone/)).toBeDefined();
  await keyboard.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(api.revokeKey).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: `Revoke ${metadata.prefix}` }));
  dialog = await openRevoke();
  const pending = deferred<void>();
  vi.mocked(api.revokeKey).mockReturnValueOnce(pending.promise);
  const submit = within(dialog).getByRole("button", { name: "Revoke key" });
  submit.focus();
  await keyboard.keyboard("{Enter}");
  expect(screen.getByText("Active", { exact: true })).toBeDefined();
  expect(submit).toHaveProperty("disabled", true);
  await keyboard.click(submit);
  expect(api.revokeKey).toHaveBeenCalledExactlyOnceWith("session-one", metadata.id);
  expect(screen.getByRole("button", { name: "Refresh keys" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Create API key" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Next" })).toHaveProperty("disabled", true);
  expect(api.listKeys).toHaveBeenCalledTimes(1);
  vi.mocked(api.listKeys).mockResolvedValue({ ...page, data: [{ ...metadata, revoked_at: metadata.created_at }] });
  await act(async () => pending.resolve());
  expect(await screen.findByText("Revoked", { exact: true })).toBeDefined();
  expect(screen.getByRole("button", { name: "Already revoked" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: /reactivate/i })).toBeNull();
  expect(api.getUsage).toHaveBeenCalledTimes(1);
});

it.each(["server", "network", "not_found"] as const)(
  "keeps %s revoke failures truthful and retryable",
  async (kind) => {
    await mount();
    vi.mocked(api.revokeKey).mockRejectedValueOnce(new PortalError(kind));
    const keyboard = userEvent.setup();
    const dialog = await openRevoke();
    await keyboard.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(new PortalError(kind).message);
    expect(screen.getByText("Active", { exact: true })).toBeDefined();
    expect(api.listKeys).toHaveBeenCalledTimes(1);
    expect(auth.clearToken).not.toHaveBeenCalled();
    vi.mocked(api.listKeys).mockRejectedValueOnce(new PortalError("server"));
    await keyboard.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    expect(await screen.findByText(`API key ${metadata.prefix} revoked.`)).toBeDefined();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not complete/i);
    expect(screen.queryByText("Active", { exact: true })).toBeNull();
  },
);

it("preserves the selected page on revocation and refresh", async () => {
  vi.mocked(api.listKeys).mockResolvedValueOnce({ ...page, has_more: true });
  await mount();
  const keyboard = userEvent.setup();
  vi.mocked(api.listKeys).mockResolvedValue({ ...page, offset: 20 });
  await keyboard.click(screen.getByRole("button", { name: "Next" }));
  const dialog = await openRevoke();
  vi.mocked(api.listKeys).mockResolvedValue({ ...page, data: [], offset: 20 });
  await keyboard.click(within(dialog).getByRole("button", { name: "Revoke key" }));
  expect(await screen.findByText("No keys on this page")).toBeDefined();
  expect(api.listKeys).toHaveBeenLastCalledWith("session-one", { limit: 20, offset: 20 });
  await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  expect(api.listKeys).toHaveBeenLastCalledWith("session-one", { limit: 20, offset: 20 });
  await keyboard.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(api.listKeys).toHaveBeenLastCalledWith("session-one", { limit: 20, offset: 0 }));
});

it.each(["list", "create", "revoke"])("clears authentication on authoritative %s JWT401", async (operation) => {
  await mount();
  const keyboard = userEvent.setup();
  if (operation === "list") {
    vi.mocked(api.listKeys).mockRejectedValueOnce(new PortalError("unauthenticated"));
    await keyboard.click(screen.getByRole("button", { name: "Refresh keys" }));
  } else if (operation === "create") {
    vi.mocked(api.createKey).mockRejectedValueOnce(new PortalError("unauthenticated"));
    await selectAndCreate();
  } else {
    vi.mocked(api.revokeKey).mockRejectedValueOnce(new PortalError("unauthenticated"));
    const dialog = await openRevoke();
    await keyboard.click(within(dialog).getByRole("button", { name: "Revoke key" }));
  }
  await screen.findByLabelText("Username");
  expect(auth.clearToken).toHaveBeenCalledTimes(1);
});
