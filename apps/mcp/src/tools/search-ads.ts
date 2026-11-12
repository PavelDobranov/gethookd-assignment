import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { notImplemented } from "./not-implemented.js";

// Canonical niche slugs from the v1 contract. Kept local to the MCP app so it
// stays independent of API code; discovery at runtime is what `list_niches` is
// for. This static list only constrains the `search_ads` input.
const nicheSlugs = [
  "skincare",
  "haircare",
  "supplements",
  "fitness",
  "pet-supplies",
  "home-decor",
  "kitchen",
  "apparel",
  "jewelry",
  "baby-kids",
  "outdoor",
  "tech-accessories",
] as const;

const description = [
  "Search GetHookd advertisements and return compact summaries.",
  "Supported filters: q (case-insensitive keyword substring over headline and body text),",
  "niche (one or more niche slugs), format (image, video or carousel),",
  "status (active or inactive), started_after (YYYY-MM-DD, exclusive) and brand_id.",
  "Discover valid niche slugs with list_niches.",
  "Sort by newest (the default) or impressions.",
  "sort=impressions requires a brand_id, because impression ranks are only comparable within a single brand and never across brands.",
  "Request additional pages with the cursor returned by the previous response.",
  "Retrieve the full details of a specific ad with get_ad.",
].join(" ");

export function registerSearchAds(server: McpServer): void {
  server.registerTool(
    "search_ads",
    {
      title: "Search ads",
      description,
      inputSchema: z.object({
        q: z
          .string()
          .describe("Optional keyword; case-insensitive substring match on headline or body text.")
          .optional(),
        niche: z
          .array(z.enum(nicheSlugs))
          .describe("Optional list of niche slugs to match (OR within niches). Discover valid slugs with list_niches.")
          .optional(),
        format: z.enum(["image", "video", "carousel"]).describe("Optional ad format.").optional(),
        status: z.enum(["active", "inactive"]).describe("Optional ad status.").optional(),
        started_after: z
          .string()
          .describe("Optional exclusive start-date lower bound, as a YYYY-MM-DD calendar date.")
          .optional(),
        brand_id: z
          .number()
          .int()
          .positive()
          .describe("Optional advertiser id. Required when sort is impressions.")
          .optional(),
        sort: z
          .enum(["newest", "impressions"])
          .describe("Optional sort order. Defaults to newest. impressions requires brand_id.")
          .optional(),
        limit: z.number().int().min(1).max(100).describe("Optional page size, 1 to 100. Defaults to 20.").optional(),
        cursor: z
          .string()
          .describe("Optional continuation token from a previous response, used to fetch the next page.")
          .optional(),
      }),
    },
    async () => notImplemented("search_ads"),
  );
}
