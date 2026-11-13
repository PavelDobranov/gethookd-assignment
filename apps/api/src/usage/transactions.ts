import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import type { Database } from "../db/client.js";
import * as schema from "../db/schema.js";

export type ControlTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type AccountingClock = (tx: ControlTransaction) => Promise<string>;

/** Short read-committed controls only: never hold these locks across ad reads or delivery. */
export async function controlTransaction<T>(db: Database, operation: (tx: ControlTransaction) => Promise<T>) {
  // pg's pool only handles idle-client errors. A server transaction timeout can
  // emit a socket error while checked out, including during Drizzle's rollback.
  const client = await db.$client.connect();
  let connectionError: Error | undefined;
  const onError = (error: Error) => {
    connectionError = error;
  };
  client.on("error", onError);
  try {
    // No retry: a failed COMMIT can have an unknown durable outcome.
    return await drizzle({ client, schema }).transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await tx.execute(sql`SET LOCAL transaction_timeout = '1500ms'`);
        return operation(tx);
      },
      { isolationLevel: "read committed" },
    );
  } finally {
    // Discard a terminated session; ordinary lock-timeout rollback can reuse it.
    client.release(connectionError);
    client.removeListener("error", onError);
  }
}

/** Call after acquiring the relevant row lock; keep PostgreSQL's microseconds. */
export async function databaseTime(tx: ControlTransaction): Promise<string> {
  const { rows } = await tx.execute<{ instant: string }>(sql`SELECT clock_timestamp()::text AS instant`);
  return rows[0].instant;
}
