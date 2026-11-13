import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { ApiClient } from "../api-client.js";
import { registerValidatedTool, type ToolDispatch } from "../tool-dispatch.js";

const description = [
  "List the advertising niches available in GetHookd, returning each niche's slug and display name.",
  "Use the returned slugs as the niche filter in search_ads.",
].join(" ");

export function registerListNiches(server: McpServer, apiClient: ApiClient): ToolDispatch {
  return registerValidatedTool(
    server,
    "list_niches",
    {
      title: "List niches",
      description,
      inputSchema: z.strictObject({}),
    },
    async (_input, authorization) => {
      const { isError, body } = await apiClient.listNiches(authorization);
      return { isError, content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  );
}
