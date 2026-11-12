import { type Ad, adFormats, type Brand, niches } from "../ads/index.js";

const referenceDate = "2026-10-05";
const dayMs = 86_400_000;
const firstStart = Date.parse("2024-10-05");
const referenceTime = Date.parse(referenceDate);
const startDayCount = (referenceTime - firstStart) / dayMs;
const fixtureCountries = ["US", "GB", "CA", "AU", "DE", "FR", "JP", "UA"];

export function generateFixtures(): { brands: Brand[]; ads: Ad[] } {
  // Reset xorshift32 for each call; unsigned output and fixed iteration order.
  let state = 0x47484b44;
  function randomInt(limit: number): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.floor(((state >>> 0) / 0x1_0000_0000) * limit);
  }

  const brands = Array.from({ length: 300 }, (_, index) => ({
    id: index + 1,
    name: `${niches[index % niches.length].name} Brand ${String(index + 1).padStart(3, "0")}`,
  }));
  const ads: Ad[] = [];
  for (let index = 0; index < 20_000; index++) {
    const brand = brands[index % brands.length];
    const round = Math.floor(index / brands.length);
    const niche = niches[(brand.id - 1) % niches.length];
    const keyword = niche.keywords[round % niche.keywords.length];
    // Rotate per-brand schedules while retaining exact global 60%/40% counts.
    const slot = (index + round) % 5;
    const active = slot < 3;
    const startDay =
      index === 0
        ? 0
        : index === 19_999
          ? startDayCount - 1
          : randomInt(startDayCount);
    const startTime = firstStart + startDay * dayMs;
    const startDate = new Date(startTime).toISOString().slice(0, 10);
    const timing = active
      ? { status: "active" as const, endDate: null }
      : {
          status: "inactive" as const,
          endDate: new Date(
            startTime + randomInt(startDayCount - startDay + 1) * dayMs,
          )
            .toISOString()
            .slice(0, 10),
        };
    const countryIndex = randomInt(fixtureCountries.length);
    const countries = [fixtureCountries[countryIndex]];
    if (randomInt(2) === 1) {
      countries.push(
        fixtureCountries[(countryIndex + 1) % fixtureCountries.length],
      );
    }
    ads.push({
      id: `seed-ad-${String(index + 1).padStart(6, "0")}`,
      brandId: brand.id,
      headline: `${brand.name}: discover ${keyword}`,
      bodyText: `Explore ${keyword} from ${brand.name}. Collection ${round + 1} for everyday life.`,
      niche: niche.slug,
      format: adFormats[(index + round) % adFormats.length],
      ...timing,
      startDate,
      impressionRank: slot < 2 ? null : round + 1,
      countries,
      discoveredAt: new Date(referenceTime + index * 1_000),
    });
  }
  return { brands, ads };
}
