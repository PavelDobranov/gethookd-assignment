import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyMetadata } from "../portal-api";
import { Badge } from "./badge";
import { Button } from "./button";
import { Card } from "./card";
import { CodeBlock } from "./code-block";
import { EmptyState } from "./empty-state";
import { FieldError } from "./field-error";
import { KeyTable } from "./key-table";
import { Modal } from "./modal";
import { ProgressBar } from "./progress-bar";
import { SecretReveal } from "./secret-reveal";
import { Sidebar } from "./sidebar";
import { Stat, StatGrid } from "./stat-grid";
import { Toast } from "./toast";

afterEach(cleanup);

describe("Button", () => {
  it("applies variant/size classes, defaults type=button, and forwards clicks", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="destructive" size="sm" onClick={onClick}>
        Revoke
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Revoke" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.classList.contains("btn-destructive")).toBe(true);
    expect(button.classList.contains("btn-sm")).toBe(true);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("busy disables the control and marks it aria-busy", () => {
    render(<Button busy>Creating</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("supports a submit type for forms", () => {
    render(<Button type="submit">Sign in</Button>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
  });
});

describe("Card", () => {
  it("renders a labelled section by default", () => {
    render(
      <Card aria-labelledby="t">
        <h2 id="t">Usage</h2>
      </Card>,
    );
    const region = screen.getByRole("region", { name: "Usage" });
    expect(region.tagName).toBe("SECTION");
    expect(region.classList.contains("card")).toBe(true);
  });
});

describe("Badge", () => {
  it("renders a toned pill with an optional dot", () => {
    const { container } = render(
      <Badge tone="success" dot>
        Active
      </Badge>,
    );
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.classList.contains("badge-success")).toBe(true);
    expect(badge.querySelector(".badge-dot")).not.toBeNull();
  });

  it("renders a monospace chip for scopes", () => {
    const { container } = render(<Badge mono>search:read</Badge>);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.classList.contains("badge-mono")).toBe(true);
    expect(chip.textContent).toBe("search:read");
  });
});

describe("FieldError", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<FieldError />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an alert with its message", () => {
    render(<FieldError id="e">Select at least one scope.</FieldError>);
    const alert = screen.getByRole("alert");
    expect(alert.id).toBe("e");
    expect(alert.textContent).toBe("Select at least one scope.");
  });
});

describe("ProgressBar", () => {
  it("exposes aria values and escalates the level with usage", () => {
    const { rerender, container } = render(<ProgressBar value={642} max={1000} label="Quota used" />);
    const bar = screen.getByRole("progressbar", { name: "Quota used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("642");
    expect(bar.getAttribute("aria-valuemax")).toBe("1000");
    expect(container.querySelector(".progress-fill")?.getAttribute("data-level")).toBe("normal");

    rerender(<ProgressBar value={860} max={1000} />);
    expect(container.querySelector(".progress-fill")?.getAttribute("data-level")).toBe("warning");
    rerender(<ProgressBar value={1000} max={1000} />);
    expect(container.querySelector(".progress-fill")?.getAttribute("data-level")).toBe("danger");
  });
});

describe("StatGrid", () => {
  it("renders stats and omits an empty note", () => {
    render(
      <StatGrid>
        <Stat label="Used" value="642" note="64%" />
        <Stat label="Remaining" value="358" />
      </StatGrid>,
    );
    expect(screen.getByText("Used")).toBeTruthy();
    expect(screen.getByText("64%")).toBeTruthy();
    expect(screen.getByText("358")).toBeTruthy();
  });
});

describe("EmptyState", () => {
  it("renders the title, description and action", () => {
    render(
      <EmptyState title="No API keys yet" description="Create a key to start." action={<Button>Create</Button>} />,
    );
    expect(screen.getByRole("heading", { name: "No API keys yet" })).toBeTruthy();
    expect(screen.getByText("Create a key to start.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });
});

describe("Toast", () => {
  it("announces its content and fires onDismiss", async () => {
    const onDismiss = vi.fn();
    render(
      <Toast title="API key revoked" description="ghk_live_e90d can no longer authenticate." onDismiss={onDismiss} />,
    );
    expect(screen.getByRole("status").textContent).toContain("API key revoked");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar", () => {
  const items = [
    { key: "overview", label: "Overview" },
    { key: "keys", label: "API keys" },
    { key: "usage", label: "Usage" },
  ];

  it("marks the current item, routes selection, and logs out", async () => {
    const onSelect = vi.fn();
    const onSignOut = vi.fn();
    render(<Sidebar items={items} current="keys" onSelect={onSelect} username="demo" onSignOut={onSignOut} />);

    const current = screen.getByRole("button", { name: "API keys" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(onSelect).toHaveBeenCalledWith("usage");
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("KeyTable", () => {
  const base: KeyMetadata = {
    id: "11111111-1111-1111-1111-111111111111",
    prefix: "ghk_live_7f3a",
    scopes: ["search:read", "keys:manage"],
    created_at: "2026-10-02T00:00:00.000Z",
    last_used_at: "2026-11-01T00:00:00.000Z",
    revoked_at: null,
  };
  const revoked: KeyMetadata = {
    ...base,
    id: "22222222-2222-2222-2222-222222222222",
    prefix: "ghk_live_4c8a",
    last_used_at: null,
    revoked_at: "2026-11-02T00:00:00.000Z",
  };

  it("masks the prefix, shows scopes and status, and never renders a Name column", () => {
    render(<KeyTable keys={[base, revoked]} onRevoke={vi.fn()} />);
    expect(screen.getByText("ghk_live_7f3a••••")).toBeTruthy();
    expect(screen.getAllByText("Oct 2, 2026").length).toBe(2);
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.queryByText("Name")).toBeNull();
    expect(screen.getAllByText("search:read").length).toBeGreaterThan(0);
  });

  it("revokes an active key and disables the action on a revoked one", async () => {
    const onRevoke = vi.fn();
    render(<KeyTable keys={[base, revoked]} onRevoke={onRevoke} />);
    await userEvent.click(screen.getByRole("button", { name: "Revoke ghk_live_7f3a" }));
    expect(onRevoke).toHaveBeenCalledWith(base);
    expect(screen.getByRole("button", { name: "Already revoked" })).toHaveProperty("disabled", true);
  });
});

describe("SecretReveal", () => {
  const secret = `ghk_${"a".repeat(43)}`;

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the secret once and copies it to the clipboard", async () => {
    render(<SecretReveal secret={secret} />);
    expect((screen.getByLabelText("Secret key") as HTMLInputElement).value).toBe(secret);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(secret);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("falls back to manual selection when the clipboard is unavailable", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, "select");
    render(<SecretReveal secret={secret} />);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByText(/copy it manually/i)).toBeTruthy();
    expect(selectSpy).toHaveBeenCalled();
  });
});

describe("CodeBlock", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it("renders the code and copies it", async () => {
    render(<CodeBlock title="cURL" code="curl https://api.gethookd.com" />);
    expect(screen.getByText("curl https://api.gethookd.com")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("curl https://api.gethookd.com");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});

describe("Modal", () => {
  it("is a labelled modal dialog that moves focus inside", () => {
    render(
      <Modal titleId="m" onClose={vi.fn()}>
        <h2 id="m">Create API key</h2>
        <button type="button">First</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Create API key" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("closes on Escape and on a backdrop click", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal titleId="m" onClose={onClose}>
        <h2 id="m">Dialog</h2>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.querySelector(".overlay-backdrop") as HTMLElement;
    await userEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("restores focus to the previously focused element on close", () => {
    render(<button type="button">opener</button>);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    const { unmount } = render(
      <Modal titleId="m" onClose={vi.fn()}>
        <h2 id="m">Dialog</h2>
        <button type="button">Inside</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside" }));
    unmount();
    expect(document.activeElement).toBe(opener);
  });

  it("can render an alertdialog role", () => {
    render(
      <Modal titleId="m" role="alertdialog" onClose={vi.fn()}>
        <h2 id="m">Revoke this API key?</h2>
      </Modal>,
    );
    expect(screen.getByRole("alertdialog", { name: "Revoke this API key?" })).toBeTruthy();
  });
});
