import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** A tool outcome reduced to what the authority assertions need. */
export type ToolOutcome =
  | { isError: false; body: unknown }
  | { isError: true; code: string; body: { error: { code: string } } };

/**
 * Connects a real MCP client over Streamable HTTP, optionally presenting a single
 * caller Bearer credential. Omitting `authorization` sends no Authorization header
 * at all, exercising the absent-credential path end to end.
 */
export async function connectMcpClient(mcpUrl: URL, authorization?: string): Promise<Client> {
  const client = new Client({ name: "mcp-auth-integration-client", version: "0.0.0" });
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.Authorization = authorization;
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } }));
  return client;
}

/** Parses a tool result into the REST error code (on failure) or its JSON body. */
export function toolOutcome(result: Awaited<ReturnType<Client["callTool"]>>): ToolOutcome {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  const body = JSON.parse(text);
  if (result.isError) return { isError: true, code: body.error.code, body };
  return { isError: false, body };
}

/** Connects, invokes one tool with its own credential, and disconnects. */
export async function callTool(
  mcpUrl: URL,
  authorization: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const client = await connectMcpClient(mcpUrl, authorization);
  try {
    return toolOutcome(await client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
  }
}
