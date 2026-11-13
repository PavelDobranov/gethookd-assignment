import { sql } from "drizzle-orm";

import type { createDatabase } from "../../db/client.js";
import { ads } from "../../db/schema.js";

type Database = ReturnType<typeof createDatabase>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// The callback must finish the page read here, not retain the transaction for a
// client walk. Snapshot text describes insertion membership, not historical rows.
export function readFirstPage<T>(db: Database, read: (tx: Transaction) => Promise<T>) {
  return db.transaction(
    async (tx) => {
      const { rows } = await tx.execute<{ snapshot: string }>(sql`SELECT pg_current_snapshot()::text AS snapshot`);
      const data = await read(tx);
      return { snapshot: rows[0].snapshot, data };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

// Internal input: callers validate/decrypt cursor state before querying. A fresh
// SELECT supplies live row values; this predicate only fences original inserts.
export function visibleAtBoundary(snapshot: string) {
  return sql`pg_visible_in_snapshot(${ads.insertedXid}, ${snapshot}::pg_snapshot)`;
}
