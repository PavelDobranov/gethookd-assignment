export type AuthErrorKind =
  | "unauthenticated"
  | "unavailable"
  | "request"
  | "invalid_response"
  | "storage";

export class AuthError extends Error {
  constructor(
    public readonly kind: AuthErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface Credentials {
  username: string;
  password: string;
}

export interface User {
  id: string;
  username: string;
}

export interface IdentityResponse {
  user: User;
}

export interface LoginResponse extends IdentityResponse {
  token: string;
}

function invalidResponse(): AuthError {
  return new AuthError("invalid_response", "Invalid authentication response.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUser(value: unknown): User {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.username !== "string" ||
    value.username.length === 0
  ) {
    throw invalidResponse();
  }
  return { id: value.id, username: value.username };
}

async function request(
  path: "/api/auth/login" | "/api/auth/me",
  options: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    throw new AuthError(
      "unavailable",
      "Authentication service is unavailable.",
    );
  }
  if (response.status === 401) {
    throw new AuthError("unauthenticated", "Authentication is required.", 401);
  }
  if (response.status >= 500) {
    throw new AuthError(
      "unavailable",
      "Authentication service is unavailable.",
      response.status,
    );
  }
  if (!response.ok) {
    throw new AuthError(
      "request",
      "Authentication request failed.",
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponse();
  }
  if (!isRecord(body)) throw invalidResponse();
  return body;
}

export async function login(credentials: Credentials): Promise<LoginResponse> {
  const body = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: credentials.username,
      password: credentials.password,
    }),
  });
  if (!isToken(body.token)) throw invalidResponse();
  return { token: body.token, user: parseUser(body.user) };
}

export async function getIdentity(token: string): Promise<IdentityResponse> {
  if (!isToken(token)) {
    throw new AuthError("unauthenticated", "Authentication is required.");
  }
  const body = await request("/api/auth/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  return { user: parseUser(body.user) };
}

export const TOKEN_STORAGE_KEY = "gethookd.auth.token";

// Shape only: the server, never decoded claims, establishes authenticity.
function isToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  return (
    parts.length === 3 &&
    parts.every((part) => part.length > 0 && !/[^A-Za-z0-9_-]/.test(part))
  );
}

export function readToken(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (token === null || isToken(token)) return token;
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    return null;
  } catch {
    throw new AuthError("storage", "Session storage is unavailable.");
  }
}

export function storeToken(token: string): void {
  if (!isToken(token)) {
    throw new AuthError("invalid_response", "Invalid authentication response.");
  }
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    throw new AuthError("storage", "Session storage is unavailable.");
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    throw new AuthError("storage", "Session storage is unavailable.");
  }
}
