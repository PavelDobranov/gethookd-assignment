import { sql } from "drizzle-orm";
import { check, customType, date, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { type Ad, adFormats, adStatuses, niches } from "../ads/index.js";

// Operational insertion provenance, not part of the public ad domain. Keep xid8
// as text: PostgreSQL transaction IDs must never pass through JS numbers.
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
});

export const brands = pgTable("brands", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const ads = pgTable(
  "ads",
  {
    id: text("id").primaryKey(),
    brandId: integer("brand_id")
      .notNull()
      .references(() => brands.id),
    headline: text("headline").notNull(),
    bodyText: text("body_text").notNull(),
    niche: text("niche").$type<Ad["niche"]>().notNull(),
    format: text("format", { enum: adFormats }).notNull(),
    status: text("status", { enum: adStatuses }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    impressionRank: integer("impression_rank"),
    countries: text("countries").array().notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
    insertedXid: xid8("inserted_xid").notNull().default(sql`pg_current_xact_id()`),
  },
  (table) => [
    // DDL requires literal catalog constants, not runtime bind parameters.
    check(
      "ads_niche_check",
      sql`${table.niche} IN (${sql.join(
        niches.map(({ slug }) => sql`${slug}`),
        sql`, `,
      )})`.inlineParams(),
    ),
    check(
      "ads_format_check",
      sql`${table.format} IN (${sql.join(
        adFormats.map((format) => sql`${format}`),
        sql`, `,
      )})`.inlineParams(),
    ),
    check(
      "ads_status_check",
      sql`${table.status} IN (${sql.join(
        adStatuses.map((status) => sql`${status}`),
        sql`, `,
      )})`.inlineParams(),
    ),
    check("ads_impression_rank_check", sql`${table.impressionRank} > 0`),
    check(
      "ads_status_end_date_check",
      sql`(${table.status} = 'active' AND ${table.endDate} IS NULL) OR (${table.status} = 'inactive' AND ${table.endDate} IS NOT NULL)`,
    ),
    check("ads_date_order_check", sql`${table.endDate} >= ${table.startDate}`),
    // PostgreSQL's default NULL-distinct uniqueness permits unknown ranks.
    unique("ads_brand_rank_unique").on(table.brandId, table.impressionRank),
  ],
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  keyHash: text("key_hash").notNull().unique(),
});
