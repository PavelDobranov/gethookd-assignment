import { eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import { ads, brands } from "../../db/schema.js";
import { daysActive } from "../model.js";

type SummaryRow = Pick<
  typeof ads.$inferSelect,
  "id" | "brandId" | "headline" | "niche" | "format" | "status" | "startDate" | "endDate" | "impressionRank"
> & { brandName: string };

export function mapAdSummary(row: SummaryRow, now: Date) {
  return {
    id: row.id,
    brand_id: row.brandId,
    brand_name: row.brandName,
    headline: row.headline,
    niche: row.niche,
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
    impression_rank: row.impressionRank,
  };
}

export async function getAd(db: Database, id: string) {
  const [row] = await db
    .select({
      id: ads.id,
      brandId: ads.brandId,
      brandName: brands.name,
      headline: ads.headline,
      bodyText: ads.bodyText,
      niche: ads.niche,
      format: ads.format,
      status: ads.status,
      startDate: ads.startDate,
      endDate: ads.endDate,
      impressionRank: ads.impressionRank,
      countries: ads.countries,
      discoveredAt: ads.discoveredAt,
    })
    .from(ads)
    .innerJoin(brands, eq(ads.brandId, brands.id))
    .where(eq(ads.id, id));

  if (!row) return null;
  const now = new Date();
  return {
    ...mapAdSummary(row, now),
    body_text: row.bodyText,
    end_date: row.endDate,
    countries: row.countries,
    discovered_at: row.discoveredAt.toISOString(),
  };
}
