import { createServer, type Server } from "node:http";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import type { ApiClient } from "./api-client.js";
import { createMcpServer } from "./server.js";

export type McpApp = {
  server: Server;
  close: () => Promise<void>;
};

/**
 * Builds the Streamable HTTP application without starting it, so process startup
 * and tests stay separate. The handler builds a fresh McpServer per request
 * (stateless transport) and keeps no state between requests. Streamable HTTP is
 * served at POST /mcp; the localhost Host/Origin guards run first and answer any
 * other request with 403, which is the recommended loopback DNS-rebinding
 * protection for a local HTTP transport.
 */
export function createMcpApp({ apiClient }: { apiClient: ApiClient }): McpApp {
  const handler = createMcpHandler(() => createMcpServer(apiClient));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
  });

  return {
    server,
    async close() {
      // Abort in-flight MCP exchanges first, then stop accepting connections.
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // server.close() waits for open sockets; a still-connected client would
        // otherwise block shutdown forever. The exchanges are already aborted,
        // so release idle keep-alive connections to let close() complete.
        server.closeIdleConnections();
      });
    },
  };
}
