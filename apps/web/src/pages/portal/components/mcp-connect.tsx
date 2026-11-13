import { Card } from "../../../components/card";
import { CodeBlock } from "./code-block";

// Documented local defaults for the MCP Streamable HTTP server (apps/mcp).
// The panel only ever shows a secret-free template: the reader substitutes
// their own reveal-once API key for the placeholder. It never reads, stores
// or displays a managed secret.
const MCP_ENDPOINT = "http://127.0.0.1:3001/mcp";
const API_KEY_PLACEHOLDER = "<YOUR_API_KEY>";

const connectCommand = `claude mcp add --transport http gethookd ${MCP_ENDPOINT} \\\n  --header "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`;

export function McpConnect() {
  return (
    <Card className="stack" aria-labelledby="mcp-connect-heading">
      <h2 id="mcp-connect-heading">Connect Claude Code</h2>
      <p className="muted">
        Point Claude Code at the GetHookd MCP server over Streamable HTTP. Each tool call forwards your API key to the
        REST API, which stays the sole authority for scopes, revocation, rate limits and billing.
      </p>
      <ol className="stack">
        <li>
          Create an API key with the <span className="mono">search:read</span> scope and copy its secret — it is shown
          once and is never stored here.
        </li>
        <li>
          Run the command below, replacing <span className="mono">{API_KEY_PLACEHOLDER}</span> with that secret.
        </li>
      </ol>
      <CodeBlock title="Add the GetHookd MCP server" code={connectCommand} />
      <p className="alert alert-warning">
        This template contains no secret. A literal key placed in your shell history or client config must be protected
        and never committed — prefer an environment reference such as{" "}
        <span className="mono">Bearer $GETHOOKD_API_KEY</span> where your client supports it.
      </p>
    </Card>
  );
}
