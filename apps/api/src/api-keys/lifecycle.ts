import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { type ApiKeyIdentity, hashApiKey } from "./keys.js";

const allowedScopes = ["search:read", "keys:manage"] as const;
export type ApiKeyScope = (typeof allowedScopes)[number];

// Only authenticated server identities belong here; never construct from request owner IDs.
export type KeyAuthority = { kind: "user"; userId: string } | { kind: "api-key"; identity: ApiKeyIdentity };

export class KeyLifecycleError extends Error {
  constructor(public readonly code: "INVALID_SCOPES" | "INSUFFICIENT_SCOPE" | "INVALID_PAGINATION") {
    super(code);
    this.name = "KeyLifecycleError";
  }
}

function ownerFor(authority: KeyAuthority): string {
  if (authority.kind === "user") return authority.userId;
  if (!authority.identity.scopes.includes("keys:manage")) {
    throw new KeyLifecycleError("INSUFFICIENT_SCOPE");
  }
  return authority.identity.userId;
}

function canonicalScopes(input: unknown): ApiKeyScope[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    new Set(input).size !== input.length ||
    input.some((scope) => !allowedScopes.includes(scope))
  ) {
    throw new KeyLifecycleError("INVALID_SCOPES");
  }
  return allowedScopes.filter((scope) => input.includes(scope));
}

// Explicit allowlist: neither hashes nor owner IDs can escape through management results.
const { id, prefix, scopes, createdAt, lastUsedAt, revokedAt } = getTableColumns(apiKeys);
const metadataColumns = { id, prefix, scopes, createdAt, lastUsedAt, revokedAt };
function metadata(row: Pick<typeof apiKeys.$inferSelect, keyof typeof metadataColumns>) {
  return {
    id: row.id,
    prefix: row.prefix,
    scopes: row.scopes,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

/** Not retry-safe: the returned secret cannot be recovered from storage. */
export async function createApiKey(db: Database, authority: KeyAuthority, input: unknown) {
  const userId = ownerFor(authority);
  const scopes = canonicalScopes(input);
  if (authority.kind === "api-key" && scopes.some((scope) => !authority.identity.scopes.includes(scope))) {
    throw new KeyLifecycleError("INSUFFICIENT_SCOPE");
  }
  const secret = `ghk_${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      keyHash: hashApiKey(secret),
      prefix: secret.slice(0, 12),
      scopes,
    })
    .returning(metadataColumns);
  return { data: metadata(row), secret };
}

export async function listApiKeys(
  db: Database,
  authority: KeyAuthority,
  { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
) {
  const userId = ownerFor(authority);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new KeyLifecycleError("INVALID_PAGINATION");
  }
  const rows = await db
    .select(metadataColumns)
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt), asc(apiKeys.id))
    .limit(limit + 1)
    .offset(offset);
  return { data: rows.slice(0, limit).map(metadata), limit, offset, has_more: rows.length > limit };
}

/** Missing and foreign targets both return null. Repeated revocation retains the original instant. */
export async function revokeApiKey(db: Database, authority: KeyAuthority, keyId: string) {
  const userId = ownerFor(authority);
  const [row] = await db
    .update(apiKeys)
    .set({
      revokedAt: sql`coalesce(${apiKeys.revokedAt}, clock_timestamp())`,
    })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
    .returning(metadataColumns);
  return row ? metadata(row) : null;
}
