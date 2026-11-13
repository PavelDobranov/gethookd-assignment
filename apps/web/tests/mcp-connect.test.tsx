import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../src/app";
import * as auth from "../src/auth";
import { McpConnect } from "../src/pages/portal/components/mcp-connect";
import * as api from "../src/portal-api";

vi.mock("../src/auth", async (original) => ({
  ...(await original<typeof auth>()),
  readToken: vi.fn(),
  getIdentity: vi.fn(),
  clearToken: vi.fn(),
}));
vi.mock("../src/portal-api", async (original) => ({
  ...(await original<typeof api>()),
  listKeys: vi.fn(),
  summarizeKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  getUsage: vi.fn(),
}));

// The exact, secret-free Streamable HTTP template the panel offers to copy.
const EXPECTED_COMMAND =
  'claude mcp add --transport http gethookd http://127.0.0.1:3001/mcp \\\n  --header "Authorization: Bearer <YOUR_API_KEY>"';

function setClipboard(writeText?: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("McpConnect panel", () => {
  it("renders a secret-free Streamable HTTP configuration template", () => {
    render(<McpConnect />);
    expect(screen.getByRole("heading", { name: "Connect Claude Code" })).toBeTruthy();
    const command = screen.getByText(/claude mcp add/);
    expect(command.textContent).toContain("--transport http gethookd http://127.0.0.1:3001/mcp");
    expect(command.textContent).toContain("Authorization: Bearer <YOUR_API_KEY>");
    // The template carries a placeholder only, never a real reveal-once secret.
    expect(command.textContent).not.toMatch(/ghk_/);
  });

  it("copies the exact template and reports success without persisting anything", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<McpConnect />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(EXPECTED_COMMAND);
    expect(await screen.findByText(/Copied to clipboard/)).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("offers a manual-copy fallback when the clipboard rejects", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<McpConnect />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByText(/copy it manually/i)).toBeTruthy();
  });

  it("offers a manual-copy fallback when the clipboard is unavailable", async () => {
    setClipboard(undefined);
    render(<McpConnect />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByText(/copy it manually/i)).toBeTruthy();
  });
});

describe("McpConnect lifecycle within the protected portal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setClipboard(vi.fn().mockResolvedValue(undefined));
    vi.mocked(api.listKeys).mockResolvedValue({ data: [], limit: 20, offset: 0, has_more: false });
    vi.mocked(api.summarizeKeys).mockResolvedValue({ active: 0, revoked: 0, lastUsedAt: null, lastPrefix: null });
    vi.mocked(api.getUsage).mockResolvedValue({
      data: {
        period_start: "2026-06-01T00:00:00.000Z",
        period_end: "2026-07-01T00:00:00.000Z",
        billable_calls: 0,
        quota: 1000,
        remaining: 1000,
      },
    });
    sessionStorage.clear();
    localStorage.clear();
  });

  it("is shown on the authenticated overview but not before sign-in", async () => {
    vi.mocked(auth.readToken).mockReturnValue(null);
    const anonymous = render(<App />);
    await screen.findByRole("button", { name: /sign in/i });
    expect(screen.queryByRole("heading", { name: "Connect Claude Code" })).toBeNull();
    anonymous.unmount();

    vi.mocked(auth.readToken).mockReturnValue("session-one");
    vi.mocked(auth.getIdentity).mockResolvedValue({ user: { id: "owner-one", username: "demo" } });
    render(<App />);
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.getByRole("heading", { name: "Connect Claude Code" })).toBeTruthy();
  });
});
