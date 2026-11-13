import { createContext, useContext } from "react";

import type { AppActions, AppState } from "./types";

// Two contexts, deliberately split: a consumer that only needs to dispatch
// intents (e.g. the sidebar) subscribes to AppActionsContext and never
// re-renders when server data in AppStateContext changes.

export const AppStateContext = createContext<AppState | null>(null);
export const AppActionsContext = createContext<AppActions | null>(null);

export function useAppState(): AppState {
  const state = useContext(AppStateContext);

  if (state === null) {
    throw new Error("useAppState must be used within a PortalProvider.");
  }

  return state;
}

export function useAppActions(): AppActions {
  const actions = useContext(AppActionsContext);

  if (actions === null) {
    throw new Error("useAppActions must be used within a PortalProvider.");
  }

  return actions;
}
