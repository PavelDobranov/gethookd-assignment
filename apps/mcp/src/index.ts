import { createApiClient } from "./api-client.js";
import { loadMcpConfig } from "./config.js";
import { createMcpApp } from "./transport.js";

const config = loadMcpConfig();
const apiClient = createApiClient({ baseUrl: config.apiBaseUrl });
const app = createMcpApp();

app.server.on("error", (error) => {
  console.error("MCP server failed to start:", error);
  process.exitCode = 1;
});

app.server.listen(config.port, config.host, () => {
  console.log(`MCP server listening on http://${config.host}:${config.port}/mcp`);
  console.log(`REST API base URL (not called yet): ${apiClient.baseUrl}`);
});

async function shutdown() {
  try {
    await app.close();
  } catch (error) {
    console.error("MCP server shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
