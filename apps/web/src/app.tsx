import { type FormEvent, useState } from "react";
import {
  AuthError,
  clearToken,
  getIdentity,
  login,
  storeToken,
  type User,
} from "./auth";
import "./styles.css";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const credentials = {
      username: String(data.get("username")),
      password: String(data.get("password")),
    };
    const password = form.elements.namedItem("password");
    if (password instanceof HTMLInputElement) password.value = "";
    setBusy(true);
    setError("");
    try {
      const result = await login(credentials);
      const identity = await getIdentity(result.token);
      storeToken(result.token);
      setUser(identity.user);
    } catch (failure) {
      setError(
        failure instanceof AuthError && failure.kind === "unauthenticated"
          ? "Check your username or password and try again."
          : "Sign-in is unavailable. Please try again later.",
      );
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    setUser(null);
    try {
      clearToken();
      setError("");
    } catch {
      setError(
        "Session storage is unavailable. Close this tab to end the session.",
      );
    }
  }

  return (
    <main>
      {user ? (
        <>
          <h1>{user.username}</h1>
          <button type="button" onClick={logout}>
            Log out
          </button>
        </>
      ) : (
        <>
          <h1>GetHookd Developer Portal</h1>
          <form onSubmit={submit} aria-busy={busy}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              required
              maxLength={100}
              disabled={busy}
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
              disabled={busy}
            />
            <button type="submit" disabled={busy}>
              Sign in
            </button>
          </form>
          {busy && <p role="status">Signing in…</p>}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </main>
  );
}
