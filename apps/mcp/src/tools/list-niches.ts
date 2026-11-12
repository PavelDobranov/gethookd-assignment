import type { McpServer } from "@modelcontextprotocol/server";

import { notImplemented } from "./not-implemented.js";

const description = [
  "List the advertising niches available in GetHookd, returning each niche's slug and display name.",
  "Use the returned slugs as the niche filter in search_ads.",
].join(" ");

export function registerListNiches(server: McpServer): void {
  // No inputs: the tool takes no arguments, so no input schema is registered.
  server.registerTool(
    "list_niches",
    {
      title: "List niches",
      description,
    },
    async () => notImplemented("list_niches"),
  );
}
