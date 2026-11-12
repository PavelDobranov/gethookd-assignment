import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { notImplemented } from "./not-implemented.js";

const description = [
  "Retrieve the complete details of a single GetHookd advertisement by its id.",
  "Use this to look up an ad you have already identified, for example from search_ads results;",
  "it does not discover or search for ads.",
  "The id is an opaque string returned by search_ads and must not be parsed or treated as an integer.",
].join(" ");

export function registerGetAd(server: McpServer): void {
  server.registerTool(
    "get_ad",
    {
      title: "Get ad",
      description,
      inputSchema: z.object({
        id: z.string().min(1).describe("The opaque ad id returned by search_ads. Treat it as an opaque string."),
      }),
    },
    async () => notImplemented("get_ad"),
  );
}
