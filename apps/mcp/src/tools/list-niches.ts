import type { McpServer } from "@modelcontextprotocol/server";

import type { ApiClient } from "../api-client.js";

const description = [
  "List the advertising niches available in GetHookd, returning each niche's slug and display name.",
  "Use the returned slugs as the niche filter in search_ads.",
].join(" ");

export function registerListNiches(server: McpServer, apiClient: ApiClient): void {
  // No inputs: the tool takes no arguments, so no input schema is registered.
  server.registerTool(
    "list_niches",
    {
      title: "List niches",
      description,
    },
    async () => {
      const { isError, body } = await apiClient.listNiches();
      return { isError, content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  );
}
