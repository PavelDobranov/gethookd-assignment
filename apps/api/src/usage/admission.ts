import { eq, sql } from "drizzle-orm";

import { type ApiKeyIdentity, hashApiKey } from "../api-keys/index.js";
import type { Database } from "../db/client.js";
import { apiKeys } from "../db/schema.js";
import { RATE_LIMIT_MAX } from "../limits.js";
import { type AccountingClock, controlTransaction, databaseTime } from "./transactions.js";

export type Admission =
  | { allowed: true; identity: ApiKeyIdentity }
  | { allowed: false; identity: ApiKeyIdentity; retryAfter: number };

// A burst to one key serializes on its api_keys row lock. A control transaction that
// ages past its 1500ms transaction_timeout while legitimately queued (e.g. a checkpoint
// stall) is killed before it decides, even though its own lock waits never exceed the
// 500ms lock_timeout. That is self-inflicted contention, not a stuck lock, so a bounded
// retry of the aborted attempt is correct: every request still receives a decision, and
// a genuinely held lock (whose waiter does trip the 500ms lock_timeout each time) still
// fails closed once the attempts are spent. See docs/agents/adr/0006-admission-contention-retry.md.
const MAX_ADMISSION_ATTEMPTS = 5;

/** Commit authentication/allowance before any scope, input, read or billing work. */
export async function admitApiKey(
  db: Database,
  credential: unknown,
  clock: AccountingClock = databaseTime,
): Promise<Admission | null> {
  if (typeof credential !== "string" || credential.length === 0) return null;
  for (let attempt = 1; ; attempt++) {
    // `entered` marks that a connection was checked out and the control transaction's body
    // ran; `decided` marks that the non-idempotent append was handed to COMMIT. A retry is
    // confined to a started-but-aborted attempt: failing before the body (e.g. no database
    // connection) stays fail-closed, and a failure at or after COMMIT is never replayed.
    const progress = { entered: false, decided: false };
    try {
      return await admitOnce(db, credential, clock, progress);
    } catch (error) {
      if (!progress.entered || progress.decided || attempt >= MAX_ADMISSION_ATTEMPTS) throw error;
      // Jitter so a synchronized cohort does not re-contend in lockstep.
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 20)));
    }
  }
}

async function admitOnce(
  db: Database,
  credential: string,
  clock: AccountingClock,
  progress: { entered: boolean; decided: boolean },
): Promise<Admission | null> {
  return controlTransaction(db, async (tx) => {
    // A connection is held and the transaction is open: contention aborts from here are
    // self-inflicted queueing on the key row, not an inability to reach the database.
    progress.entered = true;
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
        SELECT admissions, CASE WHEN cardinality(admissions) < ${RATE_LIMIT_MAX} THEN 0 ELSE
          greatest(1, ceil(extract(epoch FROM (
            (SELECT min(a) FROM unnest(admissions) a) + interval '60 seconds' - ${instant}::timestamptz
          ))))::integer END AS retry_after FROM retained
      )
      UPDATE api_keys SET last_used_at = greatest(last_used_at, ${instant}::timestamptz),
        rate_admissions = CASE WHEN decision.retry_after = 0
          THEN array_append(decision.admissions, ${instant}::timestamptz) ELSE decision.admissions END
      FROM decision WHERE api_keys.id = ${key.id}::uuid RETURNING decision.retry_after
    `);
    // The decision is written; only the pending COMMIT can still fail, and that is not replayable.
    progress.decided = true;
    // A denied allowance is a committed authentication, not a transaction error.
    return result.retry_after === 0
      ? { allowed: true, identity }
      : { allowed: false, identity, retryAfter: result.retry_after };
  });
}
