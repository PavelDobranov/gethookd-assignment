import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./app";
import { TOKEN_STORAGE_KEY } from "./auth";

const token = "header.payload.signature";
const user = { id: "server-id", username: "server-verified-user" };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

async function submitLogin() {
  const keyboard = userEvent.setup();
  await keyboard.tab();
  expect(document.activeElement).toBe(screen.getByLabelText("Username"));
  await keyboard.keyboard("demo");
  await keyboard.tab();
  await keyboard.keyboard("demo-password{Enter}");
}

it("offers an accessible login without a token or protected content", () => {
  render(<App />);
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(screen.getByLabelText("Password").getAttribute("type")).toBe(
    "password",
  );
  expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("submits by keyboard, verifies identity, stores only JWT and logs out", async () => {
  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        token,
        user: { ...user, username: "untrusted-login-name" },
      }),
    )
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
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const keyboard = userEvent.setup();
  screen.getByRole("button", { name: "Log out" }).focus();
  await keyboard.keyboard("{Enter}");
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(screen.queryByText(user.username)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("shows a generic credential error and persists nothing on 401", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: "private detail" }, { status: 401 }),
  );
  render(<App />);
  await submitLogin();
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /username or password/i,
  );
  expect(screen.queryByText("private detail")).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
    "",
  );
});

it("disables duplicate submissions while login is pending", async () => {
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  render(<App />);
  await submitLogin();
  expect(screen.getByRole("status").textContent).toMatch(/signing in/i);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(user.username)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  resolve(Response.json({}, { status: 503 }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /unavailable/i,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(sessionStorage.length).toBe(0);
});
