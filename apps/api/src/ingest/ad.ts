import { randomUUID } from "node:crypto";
import { type Ad, adFormats, niches } from "../ads/index.js";

export function createIngestAd({
  brandId,
  now,
  random,
}: {
  brandId: number;
  now: Date;
  random: () => number;
}): Ad {
  const niche = niches[Math.floor(random() * niches.length)];
  const format = adFormats[Math.floor(random() * adFormats.length)];
  const daysBack = random() < 0.3 ? 1 + Math.floor(random() * 90) : 0;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - daysBack);
  return {
    id: `ingest-ad-${randomUUID()}`,
    brandId,
    headline: `Discover ${niche.keywords[0]}`,
    bodyText: `Explore our latest ${niche.name} collection.`,
    niche: niche.slug,
    format,
    status: "active",
    startDate: start.toISOString().slice(0, 10),
    endDate: null,
    // The transaction replaces this positive marker with the next brand-local rank.
    impressionRank: random() < 0.4 ? null : 1,
    countries: ["US", "GB"],
    discoveredAt: now,
  };
}
