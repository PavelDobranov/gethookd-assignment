import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { createDatabase } from "../db/client.js";
import { apiKeys } from "../db/schema.js";

type Database = ReturnType<typeof createDatabase>["db"];

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export async function validateApiKey(db: Database, key: unknown) {
  if (typeof key !== "string" || key.length === 0) {
    return null;
  }

  const [owner] = await db
    .select({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hashApiKey(key)))
    .limit(1);

  return owner ?? null;
}
