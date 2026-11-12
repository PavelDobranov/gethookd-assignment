import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  history.replaceState(null, "", "/");
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
  expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
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
  expect(location.pathname).toBe("/portal");
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const keyboard = userEvent.setup();
  screen.getByRole("button", { name: "Log out" }).focus();
  await keyboard.keyboard("{Enter}");
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(screen.queryByText(user.username)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(location.pathname).toBe("/login");
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
  expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/i);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(sessionStorage.length).toBe(0);
});

it("revalidates restored tokens before rendering protected content", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  render(<App />);
  expect(screen.getByRole("status").textContent).toMatch(/checking/i);
  expect(screen.queryByText(user.username)).toBeNull();
  expect(screen.queryByLabelText("Username")).toBeNull();
  resolve(Response.json({ user }));
  expect(await screen.findByText(user.username)).toBeDefined();
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
    Authorization: `Bearer ${token}`,
  });
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("clears rejected restored tokens and returns to login", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
  render(<App />);
  expect(await screen.findByLabelText("Username")).toBeDefined();
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByText(user.username)).toBeNull();
});

it.each(["network", "server"])("blocks protected content on %s failure without retrying", async (kind) => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  if (kind === "network") fetchMock.mockRejectedValueOnce(new TypeError("private details"));
  else fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  render(<App />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/i);
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
});

it("keeps the login available with a useful error if storage is blocked", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<App />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/storage.*unavailable/i);
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["/", "/login", "/portal"])("routes unauthenticated %s visits to login", (path) => {
  history.replaceState(null, "", path);
  render(<App />);
  expect(location.pathname).toBe("/login");
  expect(screen.getByLabelText("Username")).toBeDefined();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("hides the previous identity and revalidates on Back, clearing a 401", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  fetchMock.mockResolvedValueOnce(Response.json({ user }));
  render(<App />);
  await screen.findByText(user.username);
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  act(() => {
    history.replaceState(null, "", "/portal");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByText(user.username)).toBeNull();
  expect(screen.getByRole("status").textContent).toMatch(/checking/i);
  await act(async () => {
    resolve(Response.json({}, { status: 401 }));
  });
  expect(location.pathname).toBe("/login");
  expect(sessionStorage.length).toBe(0);
  act(() => {
    history.replaceState(null, "", "/portal");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByText(user.username)).toBeNull();
  expect(location.pathname).toBe("/login");
  expect(fetchMock).toHaveBeenCalledTimes(2);
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
  expect(location.pathname).toBe("/portal");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not restore a late identity after navigation and logout", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<App />);
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("alert");
  await userEvent.setup().click(screen.getByRole("button", { name: "Log out" }));
  await act(async () => {
    resolve(Response.json({ user }));
  });
  expect(screen.queryByText(user.username)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(location.pathname).toBe("/login");
});

it("ignores a login response superseded by navigation", async () => {
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<App />);
  await submitLogin();
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(async () => {
    resolve(Response.json({ token, user }));
  });
  expect(screen.queryByText(user.username)).toBeNull();
  expect(sessionStorage.length).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("revalidates a back-forward cache restoration", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  fetchMock.mockResolvedValueOnce(Response.json({ user }));
  render(<App />);
  await screen.findByText(user.username);
  fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
  act(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  expect(screen.queryByText(user.username)).toBeNull();
  await screen.findByLabelText("Username");
  expect(sessionStorage.length).toBe(0);
  expect(location.pathname).toBe("/login");
});

it("ignores a restored identity response after unmount", async () => {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  let resolve: (value: Response) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  const { unmount } = render(<App />);
  unmount();
  sessionStorage.clear();
  render(<App />);
  await act(async () => {
    resolve(Response.json({ user }));
  });
  await waitFor(() => expect(screen.getByLabelText("Username")).toBeDefined());
  expect(screen.queryByText(user.username)).toBeNull();
});
