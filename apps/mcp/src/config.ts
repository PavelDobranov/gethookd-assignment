export type McpConfig = {
  host: string;
  port: number;
  apiBaseUrl: string;
};

// Bind to loopback by default; the REST API runs on port 3000, MCP on 3001.
const defaultHost = "127.0.0.1";
const defaultPort = 3001;
const defaultApiBaseUrl = "http://127.0.0.1:3000";

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const host = env.MCP_HOST?.trim() || defaultHost;
  const port = parsePort(env.MCP_PORT) ?? defaultPort;
  const apiBaseUrl = env.API_BASE_URL?.trim() || defaultApiBaseUrl;

  try {
    new URL(apiBaseUrl);
  } catch {
    throw new Error(`Invalid API_BASE_URL: ${apiBaseUrl}`);
  }

  return { host, port, apiBaseUrl };
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_PORT: ${value}`);
  }
  return port;
}
