export type Credentials = { username: string; password: string };

export function parseCredentials(body: unknown): Credentials | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (
    !("username" in body) ||
    typeof body.username !== "string" ||
    body.username.length === 0 ||
    body.username.length > 100 ||
    !("password" in body) ||
    typeof body.password !== "string" ||
    body.password.length === 0 ||
    body.password.length > 1024
  ) {
    return null;
  }
  return { username: body.username, password: body.password };
}

export function parseBearerToken(
  authorization: string | undefined,
): string | null {
  const match =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
      authorization ?? "",
    );
  return match?.[1] ?? null;
}
