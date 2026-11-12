import { and, count, desc, eq, or, sql } from "drizzle-orm";
import type { createDatabase } from "../db/client.js";
import { ads, brands } from "../db/schema.js";
import { daysActive, niches } from "./model.js";
import type { AdParameters } from "./parameters.js";

const nicheNames = Object.fromEntries(
  niches.map(({ slug, name }) => [slug, name]),
);

export async function queryAds(
  db: ReturnType<typeof createDatabase>["db"],
  parameters: AdParameters,
) {
  const pattern = `%${parameters.q.replace(/[\\%_]/g, "\\$&")}%`;
  const filters = and(
    or(
      sql`${ads.headline} ILIKE ${pattern} ESCAPE ${"\\"}`,
      sql`${ads.bodyText} ILIKE ${pattern} ESCAPE ${"\\"}`,
    ),
    parameters.niche ? eq(ads.niche, parameters.niche) : undefined,
    parameters.format ? eq(ads.format, parameters.format) : undefined,
    parameters.status ? eq(ads.status, parameters.status) : undefined,
  );
  const [{ total }] = await db
    .select({ total: count() })
    .from(ads)
    .where(filters);
  const rows = await db
    .select({
      id: ads.id,
      brand: brands.name,
      headline: ads.headline,
      niche: ads.niche,
      format: ads.format,
      status: ads.status,
      startDate: ads.startDate,
      endDate: ads.endDate,
    })
    .from(ads)
    .innerJoin(brands, eq(ads.brandId, brands.id))
    .where(filters)
    // Legacy ordering deliberately has no tiebreaker or snapshot guarantee.
    .orderBy(desc(ads.startDate))
    .limit(parameters.perPage)
    .offset(parameters.offset);
  const now = new Date();
  return {
    data: rows.map((row) => ({
      id: row.id,
      brand: row.brand,
      headline: row.headline,
      niche: nicheNames[row.niche],
      format: row.format,
      status: row.status,
      start_date: row.startDate,
      days_active: daysActive(
        row.status === "active"
          ? { status: "active", startDate: row.startDate, endDate: null }
          : {
              status: "inactive",
              startDate: row.startDate,
              // PostgreSQL enforces a non-null end date for inactive ads.
              endDate: row.endDate as string,
            },
        now,
      ),
    })),
    page: parameters.page,
    total,
  };
}
