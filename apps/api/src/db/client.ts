import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

// The caller owns this pool: create at startup, close during shutdown/teardown.
// Importing this module neither opens connections nor runs migrations.
export function createDatabase(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
  });
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}
