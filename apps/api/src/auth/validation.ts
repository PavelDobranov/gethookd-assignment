import type { Credentials } from "./service.js";

export function parseCredentials(value: unknown): Credentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const { username, password } = value as Record<string, unknown>;

  if (typeof username !== "string" || username.length < 1 || username.length > 100) {
    return null;
  }

  if (typeof password !== "string" || password.length < 1 || password.length > 1024) {
    return null;
  }

  return { username, password };
}
