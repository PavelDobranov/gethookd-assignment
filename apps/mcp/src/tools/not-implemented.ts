import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * Scaffold placeholder for a tool that is registered and discoverable but not
 * yet connected to the REST API. Returns an explicit MCP tool error with
 * `isError: true` so clients and models see a clear NOT_IMPLEMENTED signal
 * instead of a fabricated success.
 */
export function notImplemented(toolName: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `NOT_IMPLEMENTED: ${toolName} is registered but not yet connected to the GetHookd REST API. REST integration is planned for milestone M5.`,
      },
    ],
  };
}
