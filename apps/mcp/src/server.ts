import { McpServer } from "@modelcontextprotocol/server";

import { registerGetAd } from "./tools/get-ad.js";
import { registerListNiches } from "./tools/list-niches.js";
import { registerSearchAds } from "./tools/search-ads.js";

/**
 * Creates an MCP server with the three GetHookd tools registered. A fresh
 * instance is built per request by the stateless HTTP handler, so this holds no
 * state between calls.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "gethookd-mcp", version: "0.1.0" });

  registerSearchAds(server);
  registerGetAd(server);
  registerListNiches(server);

  return server;
}
