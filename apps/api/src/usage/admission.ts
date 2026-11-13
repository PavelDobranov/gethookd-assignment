import { eq, sql } from "drizzle-orm";

import { type ApiKeyIdentity, hashApiKey } from "../api-keys/index.js";
import type { createDatabase } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { type AccountingClock, controlTransaction, databaseTime } from "./transactions.js";

type Database = ReturnType<typeof createDatabase>["db"];
export type Admission =
  | { allowed: true; identity: ApiKeyIdentity }
  | { allowed: false; identity: ApiKeyIdentity; retryAfter: number };

/** Commit authentication/allowance before any scope, input, read or billing work. */
export async function admitApiKey(
  db: Database,
  credential: unknown,
  clock: AccountingClock = databaseTime,
): Promise<Admission | null> {
  if (typeof credential !== "string" || credential.length === 0) return null;
  return controlTransaction(db, async (tx) => {
    const [key] = await tx
      .select({ id: apiKeys.id, userId: apiKeys.userId, scopes: apiKeys.scopes, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(credential)))
      .for("update");
    if (!key || key.revokedAt) return null;
    const identity: ApiKeyIdentity = { id: key.id, userId: key.userId, scopes: key.scopes };
    const instant = await clock(tx);
    // Keep both pruning and retry arithmetic in PostgreSQL: JS Date loses microseconds.
    const {
      rows: [result],
    } = await tx.execute<{ retry_after: number }>(sql`
      WITH retained AS (
        SELECT ARRAY(SELECT a FROM unnest(rate_admissions) a
          WHERE a > ${instant}::timestamptz - interval '60 seconds') AS admissions
        FROM api_keys WHERE id = ${key.id}::uuid
      ), decision AS (
        SELECT admissions, CASE WHEN cardinality(admissions) < 60 THEN 0 ELSE
          greatest(1, ceil(extract(epoch FROM (
            (SELECT min(a) FROM unnest(admissions) a) + interval '60 seconds' - ${instant}::timestamptz
          ))))::integer END AS retry_after FROM retained
      )
      UPDATE api_keys SET last_used_at = greatest(last_used_at, ${instant}::timestamptz),
        rate_admissions = CASE WHEN decision.retry_after = 0
          THEN array_append(decision.admissions, ${instant}::timestamptz) ELSE decision.admissions END
      FROM decision WHERE api_keys.id = ${key.id}::uuid RETURNING decision.retry_after
    `);
    // A denied allowance is a committed authentication, not a transaction error.
    return result.retry_after === 0
      ? { allowed: true, identity }
      : { allowed: false, identity, retryAfter: result.retry_after };
  });
}
