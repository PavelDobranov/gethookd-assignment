import { describe, expect, it } from "vitest";

import { adFormats, adStatuses, niches } from "../src/ads/model.js";
import { parseAdParameters } from "../src/ads/parameters.js";

function parse(query = "") {
  return parseAdParameters(new URLSearchParams(`api_key=test-key&${query}`));
}

describe("v0 pagination", () => {
  it.each([
    ["", 1, 20, 0],
    ["page=2", 2, 20, 20],
    ["per_page=1", 1, 1, 0],
    ["page=0002&per_page=003", 2, 3, 3],
    ["page=3&per_page=100", 3, 100, 200],
    ["page=3&per_page=101", 3, 100, 200],
    ["page=2&per_page=9007199254740991", 2, 100, 100],
    ["page=9007199254740991&per_page=1", 9007199254740991, 1, 9007199254740990],
    ["page=90071992547410&per_page=101", 90071992547410, 100, 9007199254740900],
    ["page=3002399751580331&per_page=3", 3002399751580331, 3, 9007199254740990],
  ])("parses %s to page=%s, perPage=%s, offset=%s", (query, page, perPage, offset) => {
    expect(parse(query)).toMatchObject({ page, perPage, offset });
  });

  for (const name of ["page", "per_page"]) {
    it.each([
      "",
      "0",
      "000",
      "-1",
      "1.5",
      "1.0",
      "1e2",
      "0x10",
      "NaN",
      "Infinity",
      "abc",
      "2tail",
      "+1",
      " 1",
      "1 ",
      "1\n",
      "１",
      "9007199254740992",
      "9007199254740993",
      "99999999999999999999999999999999999999999999",
    ])(`rejects invalid ${name}=%j without partial parsing or clamping unsafe input`, (value) => {
      expect(parse(new URLSearchParams({ [name]: value }).toString())).toBeNull();
    });
  }

  it.each([
    "page=90071992547411&per_page=100",
    "page=9007199254740991",
    "page=3002399751580332&per_page=3",
    "page=90071992547411&per_page=9007199254740991",
  ])("rejects unsafe offset for %s", (query) => {
    expect(parse(query)).toBeNull();
  });
});

describe("raw v0 parameters", () => {
  it("preserves a scalar key without authenticating or trimming it", () => {
    expect(parseAdParameters(new URLSearchParams("api_key=+key+"))).toMatchObject({
      apiKey: " key ",
    });
  });

  it.each(["", "api_key=", "api_key[x]=key"])("rejects missing or empty scalar key: %s", (query) =>
    expect(parseAdParameters(new URLSearchParams(query))).toBeNull(),
  );

  it.each(["q", "niche", "format", "status", "page", "per_page", "api_key"])(
    "rejects repeated recognized name %s even with empty values",
    (name) => {
      const query = new URLSearchParams("api_key=test-key");
      if (name !== "api_key") query.append(name, "");
      query.append(name, "");
      expect(parseAdParameters(query)).toBeNull();
    },
  );

  it("ignores unknown, sort, case-mismatched and bracketed names including repeats", () => {
    expect(
      parse(
        "niche[x]=bad&niche[x]=worse&sort=a&sort=b&other=1&other=2&Q=a&Q=b&api_key[]=bad&page[]=bad&per_page[x]=bad",
      ),
    ).toEqual(parse());
    expect(parse("niche=fitness&niche[x]=bad")).toMatchObject({
      niche: "fitness",
    });
    expect(parse("n%69che=fitness&niche=fitness")).toBeNull();
  });

  it.each(["", " Serum %_ ", "a+b", "猫\\test"])("preserves q as a literal substring: %s", (q) =>
    expect(parse(new URLSearchParams({ q }).toString())).toMatchObject({ q }),
  );

  it("defaults missing q to the empty substring", () => {
    expect(parse()).toMatchObject({ q: "" });
  });

  it.each(niches)("normalizes slug and display name for $slug case-insensitively", ({ slug, name }) => {
    for (const niche of [slug, name, slug.toUpperCase(), name.toUpperCase()]) {
      expect(parse(new URLSearchParams({ niche }).toString())).toMatchObject({
        niche: slug,
      });
    }
  });

  it.each(["", "unknown", " skincare", "Skincare ", " Pet Supplies "])(
    "omits invalid niche without trimming: %s",
    (niche) =>
      expect(
        parse(
          new URLSearchParams({
            niche,
            format: "video",
            status: "active",
          }).toString(),
        ),
      ).toMatchObject({ niche: undefined, format: "video", status: "active" }),
  );

  it.each(adFormats)("accepts exact format %s", (format) => {
    expect(parse(`format=${format}`)).toMatchObject({ format });
  });

  it.each(adStatuses)("accepts exact status %s", (status) => {
    expect(parse(`status=${status}`)).toMatchObject({ status });
  });

  it.each(["", "VIDEO", "Video", "video ", "unknown"])(
    "omits invalid format but preserves other filters: %s",
    (format) =>
      expect(
        parse(
          new URLSearchParams({
            niche: "Home Decor",
            format,
            status: "inactive",
          }).toString(),
        ),
      ).toMatchObject({
        niche: "home-decor",
        format: undefined,
        status: "inactive",
      }),
  );

  it.each(["", "ACTIVE", "Active", " active", "unknown"])(
    "omits invalid status but preserves other filters: %s",
    (status) =>
      expect(
        parse(
          new URLSearchParams({
            niche: "fitness",
            format: "carousel",
            status,
          }).toString(),
        ),
      ).toMatchObject({
        niche: "fitness",
        format: "carousel",
        status: undefined,
      }),
  );
});
