import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import type { createDatabase } from "../db/client.js";
import { apiKeys } from "../db/schema.js";

type Database = ReturnType<typeof createDatabase>["db"];

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export interface ApiKeyIdentity {
  id: string;
  userId: string;
  scopes: readonly string[];
}

// Deliberately re-read on every call: revocation and ownership changes are live.
export async function validateApiKeyIdentity(db: Database, key: unknown): Promise<ApiKeyIdentity | null> {
  if (typeof key !== "string" || key.length === 0) {
    return null;
  }

  const [owner] = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1);

  return owner ?? null;
}

// Preserve the M2/M3 caller contract until shared HTTP admission replaces it.
export async function validateApiKey(db: Database, key: unknown) {
  const identity = await validateApiKeyIdentity(db, key);
  return identity ? { userId: identity.userId } : null;
}
