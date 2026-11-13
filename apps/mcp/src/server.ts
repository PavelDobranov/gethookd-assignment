import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";

import type { ApiClient } from "./api-client.js";
import type { CredentialResult } from "./credentials.js";
import { authenticationToolError, internalToolError, type ToolDispatch, validationToolError } from "./tool-dispatch.js";
import { registerGetAd } from "./tools/get-ad.js";
import { registerListNiches } from "./tools/list-niches.js";
import { registerSearchAds } from "./tools/search-ads.js";

/**
 * Creates an MCP server with the three GetHookd tools registered. A fresh
 * instance is built per request by the stateless HTTP handler, so this holds no
 * state between calls. The request's `credential` is captured here, so parallel
 * callers each dispatch with their own key and cannot cross-contaminate.
 */
export function createMcpServer(apiClient: ApiClient, credential: CredentialResult): McpServer {
  const server = new McpServer({ name: "gethookd-mcp", version: "0.1.0" });

  const tools = new Map<string, ToolDispatch>([
    ["search_ads", registerSearchAds(server, apiClient)],
    ["get_ad", registerGetAd(server, apiClient)],
    ["list_niches", registerListNiches(server, apiClient)],
  ]);

  // Override eager plain-text tool validation, not protocol framing validation.
  // Discovery and dispatch share each tool's schema; the SDK projects both eras.
  server.server.setRequestHandler("tools/call", async (request) => {
    let result: CallToolResult;
    try {
      const dispatch = tools.get(request.params.name);
      if (!dispatch) {
        result = validationToolError([
          {
            parameter: "name",
            reason: "Unknown tool name.",
            allowed_values: [...tools.keys()],
            suggestion: "Choose a tool returned by tools/list.",
          },
        ]);
      } else if (!credential.ok) {
        // No usable caller key: answer locally so an unauthenticated invocation
        // never reaches REST as an anonymous read.
        result = authenticationToolError();
      } else {
        result = await dispatch(request.params.arguments ?? {}, credential.authorization);
      }
    } catch {
      result = internalToolError();
    }
    return server.server.projectCallToolResult(result, undefined);
  });

  return server;
}
