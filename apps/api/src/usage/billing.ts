import { sql } from "drizzle-orm";

import type { ApiKeyIdentity } from "../api-keys/index.js";
import type { createDatabase } from "../db/client.js";
import { type AccountingClock, controlTransaction, databaseTime } from "./transactions.js";

type Database = ReturnType<typeof createDatabase>["db"];
type BillingIdentity = Pick<ApiKeyIdentity, "id" | "userId">;
// The request-identity boundary supplies hashes, never raw headers or request snapshots.
export type BillingBinding = { valueHash: string; fingerprintHash: string };

export class BillingError extends Error {
  constructor(
    public readonly code: "IDEMPOTENCY_CONFLICT" | "QUOTA_EXCEEDED",
    public readonly periodEnd?: string,
  ) {
    super(code);
    this.name = "BillingError";
  }
}

/** Indexed, current-key-only selection shared by cleanup and its query-plan proof. */
export function expiredBindingSelection(keyId: string, instant: string) {
  return sql`SELECT api_key_id, value_hash FROM billing_bindings
    WHERE api_key_id = ${keyId}::uuid AND expires_at <= ${instant}::timestamptz
    ORDER BY expires_at LIMIT 100`;
}

function utcPeriod(instant: string) {
  return sql`date_trunc('month', ${instant}::timestamptz AT TIME ZONE 'UTC')::date`;
}

/** Trusted authenticated owner only. This reads the very aggregate that admits charges. */
export function readUsage(db: Database, ownerId: string, clock: AccountingClock = databaseTime) {
  return controlTransaction(db, async (tx) => {
    const instant = await clock(tx);
    const {
      rows: [row],
    } = await tx.execute<{ period_start: string; period_end: string; count: number }>(sql`
      SELECT p.start::text AS period_start, (p.start + interval '1 month')::date::text AS period_end,
        coalesce(m.count, 0)::integer AS count
      FROM (SELECT ${utcPeriod(instant)} AS start) p
      LEFT JOIN monthly_usage m ON m.owner_id = ${ownerId}::uuid AND m.period_start = p.start
    `);
    return {
      data: {
        period_start: `${row.period_start}T00:00:00.000Z`,
        period_end: `${row.period_end}T00:00:00.000Z`,
        billable_calls: row.count,
        quota: 1000,
        remaining: 1000 - row.count,
      },
    };
  });
}

/** Settle only a fully prepared successful result, before sending it. Never automatically retry. */
export function settleBilling(
  db: Database,
  identity: BillingIdentity,
  binding?: BillingBinding,
  clock: AccountingClock = databaseTime,
): Promise<{ charged: boolean }> {
  return controlTransaction(db, async (tx) => {
    // Serializes all this owner's keys. NO KEY UPDATE remains compatible with FK
    // key-share checks; never acquire a key-row lock while holding this owner lock.
    const owner = await tx.execute(sql`SELECT id FROM users WHERE id = ${identity.userId}::uuid FOR NO KEY UPDATE`);
    if (owner.rows.length !== 1) throw new Error("Billing owner unavailable.");
    const instant = await clock(tx);
    await tx.execute(sql`DELETE FROM billing_bindings WHERE (api_key_id, value_hash) IN
      (${expiredBindingSelection(identity.id, instant)})`);

    if (binding) {
      const { rows } = await tx.execute<{ fingerprint_hash: string }>(sql`
        SELECT fingerprint_hash FROM billing_bindings
        WHERE api_key_id = ${identity.id}::uuid AND value_hash = ${binding.valueHash}
          AND expires_at > ${instant}::timestamptz
      `);
      if (rows[0]) {
        if (rows[0].fingerprint_hash !== binding.fingerprintHash) throw new BillingError("IDEMPOTENCY_CONFLICT");
        return { charged: false };
      }
    }

    const charged = await tx.execute(sql`
      INSERT INTO monthly_usage (owner_id, period_start, count)
      VALUES (${identity.userId}::uuid, ${utcPeriod(instant)}, 1)
      ON CONFLICT (owner_id, period_start) DO UPDATE SET count = monthly_usage.count + 1
      WHERE monthly_usage.count < 1000 RETURNING count
    `);
    if (charged.rows.length === 0) {
      const {
        rows: [period],
      } = await tx.execute<{ end: string }>(sql`
        SELECT (${utcPeriod(instant)} + interval '1 month')::date::text AS end
      `);
      throw new BillingError("QUOTA_EXCEEDED", `${period.end}T00:00:00.000Z`);
    }
    if (binding) {
      await tx.execute(sql`
        INSERT INTO billing_bindings (api_key_id, value_hash, fingerprint_hash, settled_at, expires_at)
        VALUES (${identity.id}::uuid, ${binding.valueHash}, ${binding.fingerprintHash},
          ${instant}::timestamptz, ${instant}::timestamptz + interval '24 hours')
        ON CONFLICT (api_key_id, value_hash) DO UPDATE SET
          fingerprint_hash = excluded.fingerprint_hash, settled_at = excluded.settled_at, expires_at = excluded.expires_at
      `);
    }
    return { charged: true };
  });
}
