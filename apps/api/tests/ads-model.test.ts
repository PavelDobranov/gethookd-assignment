import { describe, expect, it } from "vitest";
import {
  adFormats,
  adStatuses,
  daysActive,
  isCountryCode,
  niches,
} from "../src/ads/model.js";

const expectedNiches = [
  ["skincare", "Skincare", ["serum", "glow", "SPF"]],
  ["haircare", "Haircare", ["shampoo", "curls"]],
  ["supplements", "Supplements", ["protein", "gummies"]],
  ["fitness", "Fitness", ["leggings", "dumbbell"]],
  ["pet-supplies", "Pet Supplies", ["collar", "kibble"]],
  ["home-decor", "Home Decor", ["sofa", "candle"]],
  ["kitchen", "Kitchen", ["blender", "knife"]],
  ["apparel", "Apparel", ["hoodie", "denim"]],
  ["jewelry", "Jewelry", ["necklace", "ring"]],
  ["baby-kids", "Baby & Kids", ["stroller", "onesie"]],
  ["outdoor", "Outdoor", ["tent", "backpack"]],
  ["tech-accessories", "Tech Accessories", ["charger", "phone case"]],
];

describe("ad catalog", () => {
  it("pins every niche mapping, format and status", () => {
    expect(
      niches.map(({ slug, name, keywords }) => [slug, name, keywords]),
    ).toEqual(expectedNiches);
    expect(adFormats).toEqual(["image", "video", "carousel"]);
    expect(adStatuses).toEqual(["active", "inactive"]);
  });

  it.each(["US", "GB", "UA", "DE", "JP", "AX", "AQ", "BQ", "ZW"])(
    "accepts assigned ISO-2 code %s",
    (code) => expect(isCountryCode(code)).toBe(true),
  );

  it.each([
    "",
    "ZZ",
    "UK",
    "XK",
    "EU",
    "USA",
    "us",
    " US",
    "US ",
    "U1",
    null,
    42,
  ])("rejects invalid country %s", (code) =>
    expect(isCountryCode(code)).toBe(false),
  );
});

describe("whole UTC calendar days", () => {
  it.each([
    ["2026-10-05T23:59:59.999Z", 0],
    ["2026-10-06T00:00:00.000Z", 1],
    ["2026-10-05T23:30:00-02:00", 1],
    ["2026-10-06T00:30:00+02:00", 0],
  ])("uses today's UTC date at %s", (now, expected) => {
    expect(
      daysActive(
        { startDate: "2026-10-05", status: "active", endDate: null },
        new Date(now),
      ),
    ).toBe(expected);
  });

  it("uses the actual current date by default for active ads", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(
      daysActive({ startDate: today, status: "active", endDate: null }),
    ).toBe(0);
  });

  it("uses the inactive end date, not the supplied current date", () => {
    expect(
      daysActive(
        { startDate: "2024-02-28", status: "inactive", endDate: "2024-03-01" },
        new Date("2030-01-01T00:00:00Z"),
      ),
    ).toBe(2);
    expect(
      daysActive({
        startDate: "2026-10-05",
        status: "inactive",
        endDate: "2026-10-05",
      }),
    ).toBe(0);
  });

  it("counts calendar days across a daylight-saving transition", () => {
    expect(
      daysActive(
        { startDate: "2026-03-07", status: "active", endDate: null },
        new Date("2026-03-09T00:01:00Z"),
      ),
    ).toBe(2);
  });
});
