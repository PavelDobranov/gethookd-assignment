import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod/v4";

export type ToolDispatch = (input: unknown) => Promise<CallToolResult>;

type Detail = { parameter: string; reason: string; allowed_values: string[]; suggestion: string | null };

export function toolError(code: string, message: string, nextAction: string, details: Detail[] = []): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code, message, next_action: nextAction, retryable: false, details } }),
      },
    ],
  };
}

export function internalToolError(): CallToolResult {
  return toolError(
    "INTERNAL_ERROR",
    "The tool could not be completed.",
    "Delivery outcome is unknown; no automatic retry was made. Check the API connection. For a deliberate search_ads/get_ad retry, reuse the same supplied idempotency_key; without one, another successful call can charge again.",
  );
}

export function validationToolError(details: Detail[]): CallToolResult {
  return toolError(
    "VALIDATION_ERROR",
    "Invalid tool input.",
    "Use tools/list to inspect the tool schema, correct the indicated parameters, and call again.",
    details,
  );
}

/** One schema for discovery and local validation; only public SDK APIs are used. */
export function registerValidatedTool<T>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: z.ZodType<T> },
  handler: (input: T) => Promise<CallToolResult>,
): ToolDispatch {
  server.registerTool(name, config, handler);
  return async (input) => {
    const parsed = config.inputSchema.safeParse(input);
    if (!parsed.success) {
      return validationToolError(
        parsed.error.issues.flatMap((issue) => {
          const parameters = issue.code === "unrecognized_keys" ? issue.keys : [issue.path.join(".") || "arguments"];
          return parameters.map((parameter) => ({
            parameter,
            // Zod enum diagnostics contain only schema constants, not supplied values.
            reason: issue.code === "unrecognized_keys" ? "Unknown parameter; remove it." : issue.message,
            allowed_values: issue.code === "invalid_value" ? issue.values.map(String) : [],
            suggestion:
              "Correct this parameter using the tools/list input schema; omit optional parameters you do not need.",
          }));
        }),
      );
    }
    return handler(parsed.data);
  };
}
