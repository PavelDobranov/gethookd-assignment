import type { Action, AppState } from "./types";
import { clearedSlices } from "./types";

// Pure, synchronous state machine. No I/O, no timers, no refs — every async
// concern lives in the provider, which dispatches these transitions.

// Drop modal, draft and the reveal-once secret. Shared by closeModal, view
// changes and sign-out, where lingering form or secret state would be unsafe.
function resetEphemeral(state: AppState): AppState {
  return {
    ...state,
    ui: { ...state.ui, modal: "none", revokeTarget: null, createDraft: { scopes: [] } },
    create: { pending: false, secret: "", error: "" },
  };
}

export function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "session/checking":
      return { session: { status: "checking", user: null, token: "", error: "" }, ...clearedSlices };
    case "session/anonymous":
      // An optional error carries a failed sign-in message back to the login view.
      return { session: { status: "anonymous", user: null, token: "", error: action.error ?? "" }, ...clearedSlices };
    case "session/authenticated":
      return {
        session: { status: "authenticated", user: action.user, token: action.token, error: "" },
        ...clearedSlices,
      };
    case "session/unavailable":
      return { ...state, session: { ...state.session, status: "unavailable", error: action.error } };

    case "ui/setView": {
      const reset = resetEphemeral(state);
      return { ...reset, ui: { ...reset.ui, view: action.view } };
    }
    case "ui/openCreate":
      return {
        ...state,
        ui: { ...state.ui, modal: "create", revokeTarget: null, createDraft: { scopes: [] } },
        create: { pending: false, secret: "", error: "" },
      };
    case "ui/openRevoke":
      return { ...state, ui: { ...state.ui, modal: "revoke", revokeTarget: action.key } };
    case "ui/closeModal":
      return resetEphemeral(state);
    case "ui/toggleCreateScope": {
      const current = state.ui.createDraft.scopes;
      const scopes = current.includes(action.scope)
        ? current.filter((scope) => scope !== action.scope)
        : [...current, action.scope];
      return { ...state, ui: { ...state.ui, createDraft: { scopes } } };
    }
    case "ui/setToast":
      return { ...state, ui: { ...state.ui, toast: action.toast } };
    case "ui/dismissToast":
      return { ...state, ui: { ...state.ui, toast: null } };

    case "usage/loading":
      return { ...state, usage: { ...state.usage, status: "loading" } };
    case "usage/ready":
      return { ...state, usage: { status: "ready", data: action.data } };
    case "usage/error":
      return { ...state, usage: { ...state.usage, status: "error" } };

    case "keys/loading":
      return { ...state, keys: { ...state.keys, status: "loading", pagination: action.pagination, error: "" } };
    case "keys/ready":
      return {
        ...state,
        keys: {
          ...state.keys,
          status: "ready",
          page: action.page,
          pagination: { limit: action.page.limit, offset: action.page.offset },
          error: "",
        },
      };
    case "keys/error":
      return { ...state, keys: { ...state.keys, status: "error", error: action.error } };
    case "keys/mutating":
      return { ...state, keys: { ...state.keys, mutating: action.mutating } };

    case "summary/loading":
      return { ...state, summary: { ...state.summary, status: "loading" } };
    case "summary/ready":
      return { ...state, summary: { status: "ready", ...action.summary } };
    case "summary/error":
      return { ...state, summary: { ...state.summary, status: "error" } };

    case "create/pending":
      return { ...state, create: { pending: true, secret: "", error: "" } };
    case "create/success":
      return { ...state, create: { pending: false, secret: action.secret, error: "" } };
    case "create/error":
      return { ...state, create: { pending: false, secret: "", error: action.error } };
    case "create/dismissSecret":
      return { ...state, create: { ...state.create, secret: "" } };

    default:
      return state;
  }
}
