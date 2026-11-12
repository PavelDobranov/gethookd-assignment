# @gethookd/mcp

MCP server for GetHookd. It exposes GetHookd ad search to MCP clients (AI agents)
over **Streamable HTTP**, and will reach the data by calling the REST API
(`apps/api`) over HTTP — never the database directly.

This is the **M5 scaffold**: the server runs, the tools are discoverable with
real descriptions and input schemas, but the handlers are not yet connected to
REST.

## Running

```bash
# Development (watch mode)
npm run dev -w @gethookd/mcp

# Build and start
npm run build -w @gethookd/mcp
npm run start -w @gethookd/mcp

# Tests
npm run test -w @gethookd/mcp
```

The server binds to `127.0.0.1:3001` by default and exposes a single endpoint:

```
POST http://127.0.0.1:3001/mcp
```

Configuration (all optional, read from the environment):

| Variable       | Default                 | Meaning                              |
| -------------- | ----------------------- | ------------------------------------ |
| `MCP_HOST`     | `127.0.0.1`             | Bind address (loopback).             |
| `MCP_PORT`     | `3001`                  | HTTP port.                           |
| `API_BASE_URL` | `http://127.0.0.1:3000` | REST API base URL, for future calls. |

The REST API (`apps/api`) runs on port `3000`.

## Connecting an MCP client

Use any MCP client that speaks Streamable HTTP, pointed at `http://127.0.0.1:3001/mcp`.
With the official TypeScript SDK v2:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "example", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3001/mcp")));

const { tools } = await client.listTools();
```

The transport is **stateless**: a fresh server instance serves each request and
no session state is kept. Loopback Host/Origin guards run in front of the handler
(DNS-rebinding protection); non-localhost requests get a `403`.

## Tools

| Tool          | Purpose                                                        | Inputs                                                                                                    |
| ------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `search_ads`  | Search ads and return compact summaries.                       | `q`, `niche[]`, `format`, `status`, `started_after`, `brand_id`, `sort`, `limit`, `cursor` (all optional) |
| `get_ad`      | Retrieve full details for one already-identified ad.           | `id` (required, opaque string)                                                                            |
| `list_niches` | Discover valid niche slugs and display names for `search_ads`. | none                                                                                                      |

`search_ads` follows the v1 search contract: niches are passed as an array of
slugs, `sort=impressions` requires a `brand_id` (impression ranks compare ads
only within a single brand), and extra pages come from the `cursor`.

## Status: implemented vs. remaining

**Implemented (scaffold):**

- A runnable Streamable HTTP MCP server at `/mcp`, stateless, loopback-bound.
- The three tools above, discoverable via `tools/list` with descriptions and
  Zod input schemas.
- Invalid arguments are rejected by SDK schema validation; valid calls return an
  explicit MCP tool error (`isError: true`) with a `NOT_IMPLEMENTED` message.
- Integration tests that drive the real MCP protocol with the official client.

**Remaining for M5 (not in this scaffold):**

- Implement the tool handlers against the REST API via `api-client.ts`:
  translate MCP inputs into v1 REST requests (including repeated `niche` query
  parameters) and map REST responses into model-friendly output.
- Forward the caller's API key as a Bearer credential to the REST API; reuse the
  v1 REST error codes rather than inventing an MCP-specific taxonomy.
- Model evaluation evidence (`MCP_EVAL.md`).

Authentication, authorization, scopes, rate limiting, metering, retries and
billing stay in the REST API and are out of scope here.
