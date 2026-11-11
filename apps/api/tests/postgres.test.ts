import pg from "pg";
import { afterAll, expect, inject, it } from "vitest";

const pool = new pg.Pool({
  connectionString: inject("postgresUrl"),
  connectionTimeoutMillis: 2000,
  query_timeout: 2000,
  max: 2,
});
afterAll(async () => {
  await pool.end();
});

it("queries the isolated PostgreSQL 17 database, not developer configuration", async () => {
  expect(inject("postgresProject")).toMatch(/^gethookd-test-[a-f0-9]{32}$/);
  const result = await pool.query(`
    SELECT current_database() AS database, current_user AS username,
           current_setting('server_version_num')::int AS version, 1 + 1 AS sum
  `);
  expect(result.rows).toEqual([
    {
      database: "gethookd_test",
      username: "gethookd_test",
      version: expect.any(Number),
      sum: 2,
    },
  ]);
  expect(result.rows[0].version).toBeGreaterThanOrEqual(170000);
  expect(result.rows[0].version).toBeLessThan(180000);
});

declare module "vitest" {
  export interface ProvidedContext {
    postgresUrl: string;
    postgresProject: string;
  }
}
