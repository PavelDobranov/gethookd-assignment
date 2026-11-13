import type { Credentials, User } from "../auth";
import type { KeyList, KeyMetadata, KeyScope, OwnerUsage } from "../portal-api";

// One app-state object drives the whole portal. The provider owns all backend
// I/O and is the only code that dispatches these actions; views and leaves read
// the resulting state and send intents. Transitions here are pure and sync.

export type SessionStatus = "checking" | "authenticated" | "anonymous" | "unavailable";
export type View = "overview" | "keys" | "usage";
export type ModalKind = "none" | "create" | "revoke";
export type AsyncStatus = "idle" | "loading" | "ready" | "error";

export interface SessionState {
  status: SessionStatus;
  user: User | null;
  token: string;
  error: string;
}

export interface CreateDraft {
  scopes: KeyScope[];
}

export interface UiState {
  view: View;
  modal: ModalKind;
  revokeTarget: KeyMetadata | null;
  toast: string | null;
  createDraft: CreateDraft;
}

export interface UsageState {
  status: AsyncStatus;
  data: OwnerUsage["data"] | null;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface KeysState {
  status: AsyncStatus;
  page: KeyList | null;
  pagination: Pagination;
  mutating: boolean;
  error: string;
}

// Client-derived counts, aggregated from every page of listKeys.
export interface KeySummary {
  active: number;
  revoked: number;
  lastUsedAt: string | null;
  lastPrefix: string | null;
}

export interface SummaryState extends KeySummary {
  status: AsyncStatus;
}

export interface CreateState {
  pending: boolean;
  secret: string; // reveal-once; cleared aggressively.
  error: string;
}

export interface AppState {
  session: SessionState;
  ui: UiState;
  usage: UsageState;
  keys: KeysState;
  summary: SummaryState;
  create: CreateState;
}

export type Action =
  | { type: "session/checking" }
  | { type: "session/authenticated"; user: User; token: string }
  | { type: "session/anonymous" }
  | { type: "session/unavailable"; error: string }
  | { type: "ui/setView"; view: View }
  | { type: "ui/openCreate" }
  | { type: "ui/openRevoke"; key: KeyMetadata }
  | { type: "ui/closeModal" }
  | { type: "ui/toggleCreateScope"; scope: KeyScope }
  | { type: "ui/setToast"; toast: string }
  | { type: "ui/dismissToast" }
  | { type: "usage/loading" }
  | { type: "usage/ready"; data: OwnerUsage["data"] }
  | { type: "usage/error" }
  | { type: "keys/loading"; pagination: Pagination }
  | { type: "keys/ready"; page: KeyList }
  | { type: "keys/error"; error: string }
  | { type: "keys/mutating"; mutating: boolean }
  | { type: "summary/loading" }
  | { type: "summary/ready"; summary: KeySummary }
  | { type: "summary/error" }
  | { type: "create/pending" }
  | { type: "create/success"; secret: string }
  | { type: "create/error"; error: string }
  | { type: "create/dismissSecret" };

// Intents exposed to views. The provider implements these; the object is
// referentially stable so action-only consumers never re-render on data change.
// Starred methods perform network I/O (auth.ts / portal-api.ts).
export interface AppActions {
  restoreSession(): Promise<void>;
  signIn(credentials: Credentials): Promise<void>;
  signOut(): void;
  setView(view: View): void;
  openCreate(): void;
  openRevoke(key: KeyMetadata): void;
  closeModal(): void;
  toggleCreateScope(scope: KeyScope): void;
  loadUsage(): Promise<void>;
  loadKeys(pagination?: Pagination): Promise<void>;
  refreshKeys(): Promise<void>;
  loadSummary(): Promise<void>;
  createKey(): Promise<void>;
  revokeKey(id: string): Promise<void>;
  dismissSecret(): void;
  dismissToast(): void;
}

export const DEFAULT_PAGINATION: Pagination = { limit: 20, offset: 0 };

// The non-session slices in their pristine form. A fresh session (restore
// start, sign-in, sign-out) resets these so stale data never leaks across.
export const clearedSlices: Omit<AppState, "session"> = {
  ui: {
    view: "overview",
    modal: "none",
    revokeTarget: null,
    toast: null,
    createDraft: { scopes: [] },
  },
  usage: { status: "idle", data: null },
  keys: {
    status: "idle",
    page: null,
    pagination: DEFAULT_PAGINATION,
    mutating: false,
    error: "",
  },
  summary: { status: "idle", active: 0, revoked: 0, lastUsedAt: null, lastPrefix: null },
  create: { pending: false, secret: "", error: "" },
};

export const initialState: AppState = {
  session: { status: "checking", user: null, token: "", error: "" },
  ...clearedSlices,
};
