# @gethookd/mcp

MCP server for GetHookd. It exposes GetHookd ad search to MCP clients (AI agents)
over **Streamable HTTP**, calling the REST API (`apps/api`) over HTTP — never
the database directly.

This is an **intermediate M5 implementation**: `list_niches` is HTTP-backed;
`search_ads` and `get_ad` remain explicit placeholders. Caller credential
forwarding is not connected yet, so the protected real API rejects tool calls
with its unchanged authentication error. No shared key or API bypass is provided.

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

| Variable       | Default                 | Meaning                                 |
| -------------- | ----------------------- | --------------------------------------- |
| `MCP_HOST`     | `127.0.0.1`             | Bind address (loopback).                |
| `MCP_PORT`     | `3001`                  | HTTP port.                              |
| `API_BASE_URL` | `http://127.0.0.1:3000` | Trusted REST API origin for tool calls. |

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

**Implemented:**

- A runnable Streamable HTTP MCP server at `/mcp`, stateless, loopback-bound.
- The three tools above, discoverable via `tools/list` with descriptions and
  Zod input schemas.
- `list_niches` makes one `GET /api/v1/niches` per invocation and returns the
  unchanged JSON in a single MCP text block. Valid REST error envelopes set
  `isError: true`; malformed responses and network failures produce sanitized
  operational errors.
- The operator-configured API URL must be an HTTP(S) origin with no credentials,
  path, query or fragment. Requests have a 10-second deadline including body
  delivery, do not follow redirects and are never automatically retried.
- Invalid arguments are rejected by SDK schema validation; `search_ads` and
  `get_ad` still return `NOT_IMPLEMENTED` tool errors for valid inputs.
- Integration tests drive the real MCP protocol with the official client and
  a controlled HTTP API fixture; discovery does not make API requests.

**Remaining for M5:**

- Implement the remaining tool handlers against the REST API via `api-client.ts`:
  translate MCP inputs into v1 REST requests (including repeated `niche` query
  parameters) and map REST responses into model-friendly output.
- Forward the caller's API key as a Bearer credential to the REST API; reuse the
  v1 REST error codes rather than inventing an MCP-specific taxonomy.
- Model evaluation evidence (`MCP_EVAL.md`).

Authentication, authorization, scopes, rate limiting, metering and billing stay
in the REST API. MCP does not retry requests; operational failures may have an
unknown delivery outcome.
