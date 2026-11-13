import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { ApiClient } from "../api-client.js";

const description = [
  "Retrieve the complete details of a single GetHookd advertisement by its id.",
  "Use this to look up an ad you have already identified, for example from search_ads results;",
  "it does not discover or search for ads.",
  "The id is an opaque string returned by search_ads and must not be parsed or treated as an integer.",
].join(" ");

export function registerGetAd(server: McpServer, apiClient: ApiClient): void {
  server.registerTool(
    "get_ad",
    {
      title: "Get ad",
      description,
      inputSchema: z.strictObject({
        id: z.string().min(1).describe("The opaque ad id returned by search_ads. Treat it as an opaque string."),
        idempotency_key: z
          .string()
          .min(1)
          .max(128)
          // Absolute end assertion: `$` alone also permits a final newline.
          .regex(/^[A-Za-z0-9._:-]+(?![\s\S])/, "Use only ASCII letters, digits, '.', '_', ':', or '-'.")
          .optional()
          .describe(
            "Optional case-sensitive billing identity: 1–128 ASCII letters, digits, '.', '_', ':', or '-'. Reuse only for a deliberate retry of the same request; omission generates no identity.",
          ),
      }),
    },
    async (input) => {
      const { isError, body } = await apiClient.getAd(input);
      return { isError, content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  );
}
