import { and, eq, inArray, lte, max } from "drizzle-orm";

import { isCountryCode } from "../ads/index.js";
import type { Database } from "../db/client.js";
import { ads, brands } from "../db/schema.js";
import { createIngestAd } from "./ad.js";

export function validateIngestCountries(countries: unknown): asserts countries is string[] {
  if (!Array.isArray(countries) || !countries.every(isCountryCode)) {
    throw new Error("Invalid ingest countries.");
  }
}

// One caller/process owns scheduling; no concurrent ingest workers are supported.
export async function runIngestTick(
  db: Database,
  {
    clock = () => new Date(),
    random = Math.random,
  }: {
    clock?: () => Date;
    random?: () => number;
  } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = clock();
    const today = now.toISOString().slice(0, 10);
    const insertCount = 1 + Math.floor(random() * 5);
    const deactivateCount = 1 + Math.floor(random() * 2);
    const availableBrands = await tx.select({ id: brands.id }).from(brands).orderBy(brands.id);

    if (!availableBrands.length) {
      throw new Error("Ingest requires existing brands.");
    }

    // Materialize only IDs, in stable order so injected randomness controls selection.
    // Future-starting active ads cannot receive a valid end date today.
    const candidates = await tx
      .select({ id: ads.id })
      .from(ads)
      .where(and(eq(ads.status, "active"), lte(ads.startDate, today)))
      .orderBy(ads.id);

    const selected: string[] = [];

    while (selected.length < deactivateCount && candidates.length) {
      const [candidate] = candidates.splice(Math.floor(random() * candidates.length), 1);
      selected.push(candidate.id);
    }

    if (selected.length) {
      await tx.update(ads).set({ status: "inactive", endDate: today }).where(inArray(ads.id, selected));
    }

    const maxima = new Map(
      (
        await tx
          .select({ brandId: ads.brandId, rank: max(ads.impressionRank) })
          .from(ads)
          .groupBy(ads.brandId)
      ).map(({ brandId, rank }) => [brandId, rank ?? 0]),
    );

    for (let index = 0; index < insertCount; index++) {
      const brand = availableBrands[Math.floor(random() * availableBrands.length)];
      const ad = createIngestAd({ brandId: brand.id, now, random });

      validateIngestCountries(ad.countries);

      if (ad.impressionRank !== null) {
        const rank = (maxima.get(brand.id) ?? 0) + 1;

        if (rank > 2_147_483_647) {
          throw new Error("Ingest rank space exhausted.");
        }

        ad.impressionRank = rank;
        maxima.set(brand.id, rank);
      }

      await tx.insert(ads).values(ad);
    }
  });
}
