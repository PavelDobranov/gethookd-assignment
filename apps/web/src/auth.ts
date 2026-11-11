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
