import { afterEach, describe, expect, it, vi } from "vitest";

import { isCountryCode, niches } from "../src/ads/model.js";
import { generateFixtures } from "../src/db/fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("deterministic ad world", () => {
  it("is deeply identical across calls and independent of the current clock or randomness", () => {
    const first = generateFixtures();
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Fixture generation must use its fixed seed");
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
      expect(generateFixtures()).toEqual(first);
      vi.setSystemTime(new Date("1990-01-01T00:00:00Z"));
      expect(generateFixtures()).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has exact counts, distributions and stable unique IDs", () => {
    const { brands, ads } = generateFixtures();
    expect(brands).toHaveLength(300);
    expect(ads).toHaveLength(20_000);
    expect(brands.map((brand) => brand.id)).toEqual(Array.from({ length: 300 }, (_, index) => index + 1));
    expect(new Set(brands.map((brand) => brand.name)).size).toBe(300);
    expect(ads.map((ad) => ad.id)).toEqual(
      Array.from({ length: 20_000 }, (_, index) => `seed-ad-${String(index + 1).padStart(6, "0")}`),
    );
    expect(ads.filter((ad) => ad.status === "active")).toHaveLength(12_000);
    expect(ads.filter((ad) => ad.impressionRank === null)).toHaveLength(8_000);
    expect(new Set(ads.map((ad) => ad.format))).toEqual(new Set(["image", "video", "carousel"]));
    expect(new Set(ads.map((ad) => ad.niche))).toEqual(new Set(niches.map((niche) => niche.slug)));
    for (const brand of brands) {
      expect(brand.name.length).toBeGreaterThan(0);
      expect(ads.some((ad) => ad.brandId === brand.id)).toBe(true);
    }
  });

  it("includes every required keyword in its niche's headlines", () => {
    const { ads } = generateFixtures();
    for (const niche of niches) {
      const headlines = ads.filter((ad) => ad.niche === niche.slug).map((ad) => ad.headline);
      for (const keyword of niche.keywords) {
        expect(
          headlines.some((headline) => headline.includes(keyword)),
          keyword,
        ).toBe(true);
      }
    }
  });

  it("spans the fixed two-year window with valid countries, dates and discovery timestamps", () => {
    const { brands, ads } = generateFixtures();
    const brandIds = new Set(brands.map((brand) => brand.id));
    const dates = ads.map((ad) => ad.startDate).sort();
    expect(dates[0]).toBe("2024-10-05");
    expect(dates.at(-1)).toBe("2026-10-04");
    for (const ad of ads) {
      expect(brandIds.has(ad.brandId)).toBe(true);
      expect(ad.headline.length).toBeGreaterThan(0);
      expect(ad.bodyText.length).toBeGreaterThan(0);
      expect(ad.countries.length).toBeGreaterThan(0);
      expect(ad.countries.every(isCountryCode)).toBe(true);
      expect(new Set(ad.countries).size).toBe(ad.countries.length);
      expect(new Date(ad.startDate).toISOString().slice(0, 10)).toBe(ad.startDate);
      expect(ad.discoveredAt.toISOString()).toMatch(/^2026-10-05T\d{2}:\d{2}:\d{2}\.000Z$/);
      if (ad.status === "active") {
        expect(ad.endDate).toBeNull();
      } else {
        expect(ad.status).toBe("inactive");
        expect(ad.endDate).not.toBeNull();
        expect(new Date(ad.endDate).toISOString().slice(0, 10)).toBe(ad.endDate);
        expect(ad.endDate >= ad.startDate).toBe(true);
        expect(ad.endDate <= "2026-10-05").toBe(true);
      }
    }
  });

  it("keeps known ranks positive and brand-local unique, with gaps, nulls and cross-brand equality", () => {
    const { ads } = generateFixtures();
    const ranksByBrand = new Map<number, Set<number>>();
    for (const ad of ads) {
      if (ad.impressionRank === null) continue;
      expect(Number.isInteger(ad.impressionRank)).toBe(true);
      expect(ad.impressionRank).toBeGreaterThan(0);
      const ranks = ranksByBrand.get(ad.brandId) ?? new Set<number>();
      expect(ranks.has(ad.impressionRank)).toBe(false);
      ranks.add(ad.impressionRank);
      ranksByBrand.set(ad.brandId, ranks);
    }
    expect(ranksByBrand.size).toBe(300);
    const firstBrandRanks = [...(ranksByBrand.get(1) ?? [])].sort((a, b) => a - b);
    expect(firstBrandRanks.some((rank, i) => i > 0 && rank > firstBrandRanks[i - 1] + 1)).toBe(true);
    expect(ads.filter((ad) => ad.brandId === 1 && ad.impressionRank === null).length).toBeGreaterThan(1);
    expect([...(ranksByBrand.get(2) ?? [])].some((rank) => ranksByBrand.get(1)?.has(rank))).toBe(true);
  });

  it("returns fresh records and nested values, without state leaking across calls", () => {
    const first = generateFixtures();
    const expected = generateFixtures();
    first.brands[0].name = "changed";
    first.ads[0].countries.push("ZZ");
    first.ads[0].discoveredAt.setUTCFullYear(2100);
    expect(generateFixtures()).toEqual(expected);
  });
});
