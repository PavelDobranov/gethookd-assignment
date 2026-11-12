import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { AuthError, clearToken, getIdentity, login, readToken, storeToken, type User } from "./auth";
import "./styles.css";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);

  const restore = useCallback(async () => {
    const request = ++generation.current;
    setUser(null);
    setChecking(true);
    setBusy(false);
    setError("");
    setUnavailable(false);
    try {
      const token = readToken();
      if (token) {
        const identity = await getIdentity(token);
        if (request !== generation.current) return;
        setUser(identity.user);
        history.replaceState(null, "", "/portal");
      } else {
        history.replaceState(null, "", "/login");
      }
    } catch (failure) {
      if (request !== generation.current) return;
      if (failure instanceof AuthError && failure.kind === "unauthenticated") {
        history.replaceState(null, "", "/login");
        try {
          clearToken();
        } catch {
          setError("Session storage is unavailable. Close this tab to end the session.");
        }
      } else if (failure instanceof AuthError && failure.kind === "storage") {
        history.replaceState(null, "", "/login");
        setError("Session storage is unavailable. Enable it to sign in.");
      } else {
        setUnavailable(true);
        setError("Authentication is unavailable. Retry or log out.");
      }
    } finally {
      if (request === generation.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void restore();
    const navigate = () => void restore();
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) void restore();
    };
    window.addEventListener("popstate", navigate);
    window.addEventListener("pageshow", resume);
    return () => {
      generation.current++;
      window.removeEventListener("popstate", navigate);
      window.removeEventListener("pageshow", resume);
    };
  }, [restore]);

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
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await login(credentials);
      if (request !== generation.current) return;
      const identity = await getIdentity(result.token);
      if (request !== generation.current) return;
      storeToken(result.token);
      setUser(identity.user);
      history.replaceState(null, "", "/portal");
    } catch (failure) {
      if (request !== generation.current) return;
      setError(
        failure instanceof AuthError && failure.kind === "unauthenticated"
          ? "Check your username or password and try again."
          : "Sign-in is unavailable. Please try again later.",
      );
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  function logout() {
    generation.current++;
    setChecking(false);
    setBusy(false);
    history.replaceState(null, "", "/login");
    setUser(null);
    setUnavailable(false);
    try {
      clearToken();
      setError("");
    } catch {
      setError("Session storage is unavailable. Close this tab to end the session.");
    }
  }

  if (checking) {
    return (
      <main>
        <p role="status">Checking session…</p>
      </main>
    );
  }

  if (unavailable) {
    return (
      <main>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void restore()}>
          Retry
        </button>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </main>
    );
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
            <input id="username" name="username" autoComplete="username" required maxLength={100} disabled={busy} />
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
