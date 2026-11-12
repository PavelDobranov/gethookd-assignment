export const niches = [
  { slug: "skincare", name: "Skincare", keywords: ["serum", "glow", "SPF"] },
  { slug: "haircare", name: "Haircare", keywords: ["shampoo", "curls"] },
  {
    slug: "supplements",
    name: "Supplements",
    keywords: ["protein", "gummies"],
  },
  { slug: "fitness", name: "Fitness", keywords: ["leggings", "dumbbell"] },
  {
    slug: "pet-supplies",
    name: "Pet Supplies",
    keywords: ["collar", "kibble"],
  },
  { slug: "home-decor", name: "Home Decor", keywords: ["sofa", "candle"] },
  { slug: "kitchen", name: "Kitchen", keywords: ["blender", "knife"] },
  { slug: "apparel", name: "Apparel", keywords: ["hoodie", "denim"] },
  { slug: "jewelry", name: "Jewelry", keywords: ["necklace", "ring"] },
  { slug: "baby-kids", name: "Baby & Kids", keywords: ["stroller", "onesie"] },
  { slug: "outdoor", name: "Outdoor", keywords: ["tent", "backpack"] },
  {
    slug: "tech-accessories",
    name: "Tech Accessories",
    keywords: ["charger", "phone case"],
  },
] as const;

export const adFormats = ["image", "video", "carousel"] as const;
export const adStatuses = ["active", "inactive"] as const;

// Assigned ISO 3166-1 alpha-2 codes; not reserved aliases or user-assigned codes.
const countryCodes = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
   BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
   CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
   DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
   GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
   HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
   KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
   MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
   NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
   QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
   TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
   VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/),
);

export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && countryCodes.has(value);
}

type AdTiming = { startDate: string } & (
  | { status: "active"; endDate: null }
  | { status: "inactive"; endDate: string }
);

export type Brand = { id: number; name: string };

export type Ad = AdTiming & {
  id: string;
  brandId: number;
  headline: string;
  bodyText: string;
  niche: (typeof niches)[number]["slug"];
  format: (typeof adFormats)[number];
  impressionRank: number | null;
  countries: string[];
  discoveredAt: Date;
};

// Inputs are validated calendar dates. Subtract UTC midnights, not elapsed local days.
export function daysActive(ad: AdTiming, now: Date = new Date()): number {
  const endDate =
    ad.status === "inactive" ? ad.endDate : now.toISOString().slice(0, 10);
  return (Date.parse(endDate) - Date.parse(ad.startDate)) / 86_400_000;
}
