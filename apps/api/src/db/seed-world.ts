import { sql } from "drizzle-orm";

import { isCountryCode } from "../ads/index.js";
import type { Database } from "./client.js";
import type { generateFixtures } from "./fixtures.js";
import { ads, brands } from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const batchSize = 500;
const maximumRank = 2_147_483_647;

export async function seedWorld(tx: Transaction, fixtures: ReturnType<typeof generateFixtures>) {
  for (const ad of fixtures.ads) {
    if (!Array.isArray(ad.countries) || !ad.countries.every(isCountryCode)) {
      throw new Error("Invalid fixture countries.");
    }
  }

  const existingBrands = new Set((await tx.select({ id: brands.id }).from(brands)).map((brand) => brand.id));
  const missingBrands = fixtures.brands.filter((brand) => !existingBrands.has(brand.id));

  for (let offset = 0; offset < missingBrands.length; offset += batchSize) {
    await tx.insert(brands).values(missingBrands.slice(offset, offset + batchSize));
  }

  const stored = await tx
    .select({
      id: ads.id,
      brandId: ads.brandId,
      impressionRank: ads.impressionRank,
    })
    .from(ads);

  const existingIds = new Set(stored.map((ad) => ad.id));
  const used = new Map<number, Set<number>>();
  const maxima = new Map<number, number>();

  for (const ad of [...stored, ...fixtures.ads]) {
    if (ad.impressionRank !== null) {
      maxima.set(ad.brandId, Math.max(maxima.get(ad.brandId) ?? 0, ad.impressionRank));
    }
  }

  for (const ad of stored) {
    if (ad.impressionRank === null) {
      continue;
    }

    const ranks = used.get(ad.brandId) ?? new Set<number>();

    ranks.add(ad.impressionRank);
    used.set(ad.brandId, ranks);
  }

  const missing = fixtures.ads.filter((ad) => !existingIds.has(ad.id));
  const conflicts = new Set<string>();

  // Reserve free desired fixture ranks before allocating any fallback ranks.
  for (const ad of missing) {
    if (ad.impressionRank === null) {
      continue;
    }

    const ranks = used.get(ad.brandId) ?? new Set<number>();

    if (ranks.has(ad.impressionRank)) {
      conflicts.add(ad.id);
    } else {
      ranks.add(ad.impressionRank);
    }

    used.set(ad.brandId, ranks);
  }

  const repaired = missing.map((ad) => {
    if (!conflicts.has(ad.id)) {
      return ad;
    }

    const rank = (maxima.get(ad.brandId) ?? 0) + 1;

    if (rank > maximumRank) {
      throw new Error("Fixture rank space exhausted.");
    }

    maxima.set(ad.brandId, rank);

    return { ...ad, impressionRank: rank };
  });

  for (let offset = 0; offset < repaired.length; offset += batchSize) {
    // One bound payload avoids rebuilding thousands of ORM parameters per batch.
    // jsonb_to_recordset preserves typed dates, arrays and nulls; constraints still apply.
    await tx.execute(sql`insert into "ads" (
      id, brand_id, headline, body_text, niche, format, status, start_date,
      end_date, impression_rank, countries, discovered_at
    ) select
      id, "brandId", headline, "bodyText", niche, format, status, "startDate",
      "endDate", "impressionRank", countries, "discoveredAt"
    from jsonb_to_recordset(${JSON.stringify(repaired.slice(offset, offset + batchSize))}::jsonb)
    as fixture(
      id text, "brandId" integer, headline text, "bodyText" text, niche text,
      format text, status text, "startDate" date, "endDate" date,
      "impressionRank" integer, countries text[], "discoveredAt" timestamptz
    )`);
  }
}
