import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";

import { apiKeys, monthlyUsage } from "../src/db/schema.js";

it("preserves literal quota and rate-limit CHECK DDL without bind parameters", () => {
  const dialect = new PgDialect();
  for (const [table, name, expected] of [
    [apiKeys, "api_keys_rate_admissions_check", 'cardinality("api_keys"."rate_admissions") <= 60'],
    [monthlyUsage, "monthly_usage_count_check", '"monthly_usage"."count" BETWEEN 0 AND 1000'],
  ] as const) {
    const constraint = getTableConfig(table).checks.find((check) => check.name === name);
    expect(constraint).toBeDefined();
    if (!constraint) throw new Error(`Missing constraint: ${name}`);
    const query = dialect.sqlToQuery(constraint.value);
    expect(query.sql).toBe(expected);
    expect(query.params).toEqual([]);
  }
});
