import { describe, expect, it } from "vitest";
import { createIngestAd, validateIngestCountries } from "../src/ingest/tick.js";

function sequence(...values: number[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("Random sequence exhausted");
    return value;
  };
}

const now = new Date("2027-01-01T00:00:00.123Z");
// Draws: niche, format, backdating decision, optional day offset, null rank.
function generate(...values: number[]) {
  return createIngestAd({ brandId: 7, now, random: sequence(...values) });
}

describe("controlled ingest fields", () => {
  it.each([
    [0.299999, 0, "2026-12-31"],
    [0, 0.999999, "2026-10-03"],
  ])(
    "backdates below 30%% with inclusive 1–90 UTC-day bounds",
    (chance, days, date) => {
      expect(generate(0, 0, chance, days, 0.4).startDate).toBe(date);
    },
  );

  it.each([0.3, 0.999999])("uses today at or above 30%%", (chance) => {
    expect(generate(0, 0, chance, 0.4).startDate).toBe("2027-01-01");
  });

  it.each([
    [0, null],
    [0.399999, null],
    [0.4, 1],
    [0.999999, 1],
  ])("selects null only below 40%% (%s)", (chance, rank) => {
    expect(generate(0, 0, 0.3, chance).impressionRank).toBe(rank);
  });

  it("creates distinct UUID-based active ads with actual discovery time and valid fields", () => {
    const first = generate(0, 0, 0.3, 0);
    const second = generate(0.999999, 0.999999, 0.3, 0);
    expect(first.id).toMatch(/^ingest-ad-[0-9a-f-]{36}$/);
    expect(second.id).not.toBe(first.id);
    expect(first).toMatchObject({
      brandId: 7,
      status: "active",
      endDate: null,
      niche: "skincare",
      format: "image",
      countries: ["US", "GB"],
      discoveredAt: now,
    });
    expect(second).toMatchObject({
      niche: "tech-accessories",
      format: "carousel",
    });
    expect(first.headline.length).toBeGreaterThan(0);
    expect(first.bodyText.length).toBeGreaterThan(0);
  });

  it.each([null, "US", {}, ["US", "ZZ"], ["us"], [1], [null]])(
    "rejects invalid country arrays/members: %j",
    (countries) => {
      expect(() => validateIngestCountries(countries)).toThrow(
        "Invalid ingest countries",
      );
    },
  );
  it("accepts arrays of valid ISO-2 codes", () => {
    expect(() => validateIngestCountries(["US", "GB"])).not.toThrow();
  });
});
