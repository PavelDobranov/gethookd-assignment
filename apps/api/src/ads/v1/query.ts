import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { createDatabase } from "../../db/client.js";
import { ads, brands } from "../../db/schema.js";
import type { CursorQuery, CursorState } from "./cursor.js";
import { visibleAtBoundary } from "./visibility.js";

type Database = ReturnType<typeof createDatabase>["db"];

// Both initial and continuation reads share filters, ordering and projection.
// A transaction can supply select without exposing HTTP concerns to the query.
export function queryAds(
  db: Pick<Database, "select">,
  query: CursorQuery,
  limit: number,
  continuation?: Pick<CursorState, "snapshot" | "position">,
) {
  const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
  const id = sql`${ads.id} COLLATE "C"`;
  const position = continuation?.position;
  const after = position
    ? "startDate" in position
      ? or(
          lt(ads.startDate, position.startDate),
          and(eq(ads.startDate, position.startDate), sql`${id} > ${position.id}`),
        )
      : position.rank === null
        ? and(isNull(ads.impressionRank), sql`${id} > ${position.id}`)
        : or(
            gt(ads.impressionRank, position.rank),
            and(eq(ads.impressionRank, position.rank), sql`${id} > ${position.id}`),
            isNull(ads.impressionRank),
          )
    : undefined;
  return db
    .select({
      id: ads.id,
      brandId: ads.brandId,
      brandName: brands.name,
      headline: ads.headline,
      niche: ads.niche,
      format: ads.format,
      status: ads.status,
      startDate: ads.startDate,
      endDate: ads.endDate,
      impressionRank: ads.impressionRank,
    })
    .from(ads)
    .innerJoin(brands, eq(ads.brandId, brands.id))
    .where(
      and(
        query.q
          ? or(
              sql`${ads.headline} ILIKE ${pattern} ESCAPE ${"\\"}`,
              sql`${ads.bodyText} ILIKE ${pattern} ESCAPE ${"\\"}`,
            )
          : undefined,
        query.niche.length ? inArray(ads.niche, query.niche) : undefined,
        query.format ? eq(ads.format, query.format) : undefined,
        query.status ? eq(ads.status, query.status) : undefined,
        query.startedAfter ? gt(ads.startDate, query.startedAfter) : undefined,
        query.brandId !== null ? eq(ads.brandId, query.brandId) : undefined,
        continuation ? visibleAtBoundary(continuation.snapshot) : undefined,
        after,
      ),
    )
    .orderBy(query.sort === "newest" ? desc(ads.startDate) : sql`${ads.impressionRank} ASC NULLS LAST`, id)
    .limit(limit + 1);
}
