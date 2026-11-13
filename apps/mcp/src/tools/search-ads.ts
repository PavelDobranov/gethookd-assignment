import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { ApiClient } from "../api-client.js";
import { registerValidatedTool, type ToolDispatch } from "../tool-dispatch.js";

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

export function registerSearchAds(server: McpServer, apiClient: ApiClient): ToolDispatch {
  return registerValidatedTool(
    server,
    "search_ads",
    {
      title: "Search ads",
      description,
      inputSchema: z
        .strictObject({
          q: z
            .string()
            .refine((value) => !value.includes("\0"), "q must not contain NUL characters.")
            .refine(
              (value) => [...value.trim()].length <= 500,
              "Use at most 500 Unicode code points after outer whitespace is trimmed.",
            )
            .describe("Optional keyword; case-insensitive substring match on headline or body text.")
            .optional(),
          niche: z
            .array(z.enum(nicheSlugs))
            .min(
              1,
              "Supply at least one niche slug or omit niche. To clear inherited cursor filters, start a fresh search without the cursor.",
            )
            .describe(
              "Optional list of niche slugs to match (OR within niches). Discover valid slugs with list_niches.",
            )
            .optional(),
          format: z.enum(["image", "video", "carousel"]).describe("Optional ad format.").optional(),
          status: z.enum(["active", "inactive"]).describe("Optional ad status.").optional(),
          started_after: z.iso
            .date()
            .refine((value) => !value.startsWith("0000"), "Use a real YYYY-MM-DD calendar date in years 0001–9999.")
            .describe("Optional exclusive start-date lower bound, as a YYYY-MM-DD calendar date.")
            .optional(),
          brand_id: z
            .number()
            .int()
            .positive()
            .max(2_147_483_647)
            .describe("Optional advertiser id. Required when sort is impressions.")
            .optional(),
          sort: z
            .enum(["newest", "impressions"])
            .describe("Optional sort order. Defaults to newest. impressions requires brand_id.")
            .optional(),
          limit: z.number().int().min(1).max(100).describe("Optional page size, 1 to 100. Defaults to 20.").optional(),
          cursor: z
            .string()
            .min(1)
            .max(4096)
            .regex(/^[A-Za-z0-9_.-]+(?![\s\S])/, "Use the unchanged opaque cursor returned by a previous search.")
            .describe("Optional continuation token from a previous response, used to fetch the next page.")
            .optional(),
          idempotency_key: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9._:-]+(?![\s\S])/, "Use only ASCII letters, digits, '.', '_', ':', or '-'.")
            .optional()
            .describe(
              "Optional case-sensitive billing identity: 1–128 ASCII letters, digits, '.', '_', ':', or '-'. Reuse only for a deliberate retry of the same request; omission generates no identity.",
            ),
        })
        .refine((input) => input.sort !== "impressions" || input.brand_id !== undefined || input.cursor !== undefined, {
          path: ["brand_id"],
          message:
            "sort=impressions requires brand_id for a new search. A continuation may inherit it from its cursor; REST validates the effective brand.",
        }),
    },
    async (input, authorization) => {
      const { isError, body } = await apiClient.searchAds(input, authorization);
      return { isError, content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  );
}
