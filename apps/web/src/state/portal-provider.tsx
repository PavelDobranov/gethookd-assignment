import { type ReactNode, useEffect, useMemo, useReducer, useRef } from "react";

import { AuthError, type Credentials, clearToken, getIdentity, login, readToken, storeToken } from "../auth";
import {
  createKey as apiCreateKey,
  revokeKey as apiRevokeKey,
  getUsage,
  listKeys,
  PortalError,
  summarizeKeys,
} from "../portal-api";
import { AppActionsContext, AppStateContext } from "./context";
import { appReducer } from "./reducer";
import type { AppActions, Pagination } from "./types";
import { DEFAULT_PAGINATION, initialState } from "./types";

// The backend-state manager: the single component that touches auth.ts and
// portal-api.ts. Async actions call the API, then dispatch pure reducer
// transitions; after every mutation they re-pull fresh server data so the
// context stays authoritative. Per-resource request-id guards replace the
// scattered generation/lifetime refs the old components carried.

function isAuthFailure(error: unknown): boolean {
  return (
    (error instanceof PortalError && error.kind === "unauthenticated") ||
    (error instanceof AuthError && error.kind === "unauthenticated")
  );
}

// Surface only vetted, non-server-controlled copy. PortalError/AuthError
// messages are curated in those modules; anything else gets a generic line.
function safeMessage(error: unknown): string {
  if (error instanceof PortalError || error instanceof AuthError) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

export function PortalProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // Latest state for the stable action closures to read without re-creating.
  const stateRef = useRef(state);
  stateRef.current = state;

  // One monotonic counter per resource; a response whose id is stale is dropped.
  const guards = useRef({ session: 0, usage: 0, keys: 0, summary: 0 });

  const actions = useMemo<AppActions>(() => {
    const token = () => stateRef.current.session.token;

    // Loaders take an explicit token so hydrate can use the token it just
    // obtained: right after the authenticated dispatch, stateRef still holds
    // the pre-auth render and token() would read the stale empty string.
    async function loadUsage(authToken: string = token()): Promise<void> {
      const id = ++guards.current.usage;

      dispatch({ type: "usage/loading" });

      try {
        const usage = await getUsage(authToken);

        if (guards.current.usage !== id) {
          return;
        }

        dispatch({ type: "usage/ready", data: usage.data });
      } catch (error) {
        if (guards.current.usage !== id) {
          return;
        }

        if (isAuthFailure(error)) {
          return signOut();
        }

        dispatch({ type: "usage/error" });
      }
    }

    async function loadKeys(
      pagination: Pagination = stateRef.current.keys.pagination,
      authToken: string = token(),
    ): Promise<void> {
      const id = ++guards.current.keys;

      dispatch({ type: "keys/loading", pagination });

      try {
        const page = await listKeys(authToken, pagination);

        if (guards.current.keys !== id) {
          return;
        }

        dispatch({ type: "keys/ready", page });
      } catch (error) {
        if (guards.current.keys !== id) {
          return;
        }

        if (isAuthFailure(error)) {
          return signOut();
        }

        dispatch({ type: "keys/error", error: safeMessage(error) });
      }
    }

    function refreshKeys(): Promise<void> {
      return loadKeys(stateRef.current.keys.pagination);
    }

    async function loadSummary(authToken: string = token()): Promise<void> {
      const id = ++guards.current.summary;

      dispatch({ type: "summary/loading" });

      try {
        const summary = await summarizeKeys(authToken);

        if (guards.current.summary !== id) {
          return;
        }

        dispatch({ type: "summary/ready", summary });
      } catch (error) {
        if (guards.current.summary !== id) {
          return;
        }

        if (isAuthFailure(error)) {
          return signOut();
        }

        dispatch({ type: "summary/error" });
      }
    }

    // Auth success / restore → fan out the three server reads. The view is
    // already reset to 'overview' by the session/authenticated transition.
    function hydrate(authToken: string): Promise<void> {
      return Promise.all([
        loadUsage(authToken),
        loadKeys({ limit: DEFAULT_PAGINATION.limit, offset: 0 }, authToken),
        loadSummary(authToken),
      ]).then(() => undefined);
    }

    async function restoreSession(): Promise<void> {
      const id = ++guards.current.session;

      dispatch({ type: "session/checking" });

      let stored: string | null;

      try {
        stored = readToken();
      } catch {
        if (guards.current.session !== id) {
          return;
        }

        dispatch({ type: "session/anonymous" });

        return;
      }
      if (!stored) {
        if (guards.current.session !== id) {
          return;
        }

        dispatch({ type: "session/anonymous" });

        return;
      }
      try {
        const identity = await getIdentity(stored);

        if (guards.current.session !== id) {
          return;
        }

        dispatch({ type: "session/authenticated", user: identity.user, token: stored });

        await hydrate(stored);
      } catch (error) {
        if (guards.current.session !== id) {
          return;
        }

        if (error instanceof AuthError && error.kind === "unauthenticated") {
          try {
            clearToken();
          } catch {
            // Best effort; the token is already treated as invalid.
          }

          dispatch({ type: "session/anonymous" });
        } else {
          dispatch({ type: "session/unavailable", error: "Authentication is unavailable. Retry or log out." });
        }
      }
    }

    async function signIn(credentials: Credentials): Promise<void> {
      const id = ++guards.current.session;

      dispatch({ type: "session/checking" });

      try {
        const result = await login(credentials);

        if (guards.current.session !== id) {
          return;
        }

        const identity = await getIdentity(result.token);

        if (guards.current.session !== id) {
          return;
        }

        try {
          storeToken(result.token);
        } catch {
          // Session storage unavailable; proceed for this tab's lifetime.
        }

        dispatch({ type: "session/authenticated", user: identity.user, token: result.token });

        await hydrate(result.token);
      } catch (error) {
        if (guards.current.session !== id) {
          return;
        }

        const message =
          error instanceof AuthError && error.kind === "unauthenticated"
            ? "Check your username or password and try again."
            : "Sign-in is unavailable. Please try again later.";

        dispatch({ type: "session/anonymous", error: message });
      }
    }

    function signOut(): void {
      guards.current.session += 1;
      guards.current.usage += 1;
      guards.current.keys += 1;
      guards.current.summary += 1;

      try {
        clearToken();
      } catch {
        // Best effort; closing the tab ends the session regardless.
      }

      dispatch({ type: "session/anonymous" });
    }

    async function createKey(): Promise<void> {
      if (stateRef.current.create.pending) {
        return;
      }

      const { scopes } = stateRef.current.ui.createDraft;

      dispatch({ type: "create/pending" });
      dispatch({ type: "keys/mutating", mutating: true });

      try {
        const created = await apiCreateKey(token(), scopes);
        dispatch({ type: "create/success", secret: created.secret });
        // Re-pull so the new key appears and the summary counts update.
        await Promise.all([loadKeys(stateRef.current.keys.pagination), loadSummary()]);
      } catch (error) {
        if (isAuthFailure(error)) {
          signOut();
          return;
        }
        dispatch({ type: "create/error", error: safeMessage(error) });
      } finally {
        dispatch({ type: "keys/mutating", mutating: false });
      }
    }

    async function revokeKey(id: string): Promise<void> {
      if (stateRef.current.keys.mutating) {
        return;
      }

      const target = stateRef.current.ui.revokeTarget;

      dispatch({ type: "keys/mutating", mutating: true });
      try {
        await apiRevokeKey(token(), id);

        dispatch({ type: "ui/closeModal" });
        dispatch({ type: "ui/setToast", toast: `API key ${target ? `${target.prefix} ` : ""}revoked.` });

        // Re-pull so the row flips to revoked and the summary counts update.
        await Promise.all([loadKeys(stateRef.current.keys.pagination), loadSummary()]);
      } catch (error) {
        if (isAuthFailure(error)) {
          signOut();
          return;
        }

        // Keep the dialog open and report via the toast; the user can retry.
        dispatch({ type: "ui/setToast", toast: safeMessage(error) });
      } finally {
        dispatch({ type: "keys/mutating", mutating: false });
      }
    }

    return {
      restoreSession,
      signIn,
      signOut,
      setView: (view) => dispatch({ type: "ui/setView", view }),
      openCreate: () => dispatch({ type: "ui/openCreate" }),
      openRevoke: (key) => dispatch({ type: "ui/openRevoke", key }),
      closeModal: () => dispatch({ type: "ui/closeModal" }),
      toggleCreateScope: (scope) => dispatch({ type: "ui/toggleCreateScope", scope }),
      loadUsage,
      loadKeys,
      refreshKeys,
      loadSummary,
      createKey,
      revokeKey,
      dismissSecret: () => dispatch({ type: "create/dismissSecret" }),
      dismissToast: () => dispatch({ type: "ui/dismissToast" }),
    };
  }, []);

  useEffect(() => {
    void actions.restoreSession();

    // Returning to the portal via the back/forward cache re-checks the session.
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) void actions.restoreSession();
    };

    window.addEventListener("pageshow", resume);

    return () => {
      guards.current.session += 1;
      window.removeEventListener("pageshow", resume);
    };
  }, [actions]);

  return (
    <AppActionsContext.Provider value={actions}>
      <AppStateContext.Provider value={state}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
