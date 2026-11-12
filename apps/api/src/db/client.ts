import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

// The caller owns this pool: create at startup, close during shutdown/teardown.
// Importing this module neither opens connections nor runs migrations.
export function createDatabase(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2000,
  });

  // Idle clients can fail outside a query; pg removes them before reconnecting.
  // https://node-postgres.com/apis/pool#error
  pool.on("error", () => {
    console.error("Database idle connection lost.");
  });

  const db = drizzle({ client: pool, schema });

  return { db, close: () => pool.end() };
}
