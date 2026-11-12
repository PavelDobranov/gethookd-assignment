/**
 * Minimal boundary for the REST API that the MCP tools will call over HTTP.
 *
 * The scaffold only records the base URL. Request methods arrive in M5, when the
 * tools translate MCP inputs into REST calls (for example turning the `niche`
 * array into repeated query parameters) and REST responses into model-friendly
 * output. The MCP server never touches PostgreSQL and never imports API code:
 * all data flows through this HTTP seam.
 */
export type ApiClient = {
  readonly baseUrl: string;
};

export function createApiClient({ baseUrl }: { baseUrl: string }): ApiClient {
  return { baseUrl };
}
