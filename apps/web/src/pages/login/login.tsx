import type { FormEvent } from "react";

import { Button } from "../../components/button";
import { Card } from "../../components/card";
import { useAppActions, useAppState } from "../../state/context";

export function LoginScreen() {
  const { session } = useAppState();
  const { signIn } = useAppActions();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const credentials = {
      username: String(data.get("username") ?? ""),
      password: String(data.get("password") ?? ""),
    };
    const password = form.elements.namedItem("password");
    if (password instanceof HTMLInputElement) password.value = "";
    void signIn(credentials);
  }

  return (
    <main className="login-screen">
      <Card className="login-card">
        <div>
          <h1>Developer Portal</h1>
          <p className="muted">Sign in to manage your GetHookd API keys and usage.</p>
        </div>
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor="username">
              Username
            </label>
            <input
              className="input"
              id="username"
              name="username"
              autoComplete="username"
              required
              maxLength={100}
              aria-invalid={!!session.error}
              aria-describedby={session.error ? "login-error" : undefined}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
              aria-invalid={!!session.error}
              aria-describedby={session.error ? "login-error" : undefined}
            />
          </div>
          {session.error && (
            <p id="login-error" className="alert alert-error" role="alert">
              {session.error}
            </p>
          )}
          <Button type="submit">Sign in</Button>
        </form>
      </Card>
    </main>
  );
}
