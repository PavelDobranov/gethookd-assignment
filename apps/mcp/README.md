# @gethookd/mcp

MCP server for GetHookd. It exposes GetHookd ad search to MCP clients (AI agents)
over **Streamable HTTP**, calling the REST API (`apps/api`) over HTTP — never
the database directly.

This is an **intermediate M5 implementation**: all three tools are HTTP-backed.
Caller credential forwarding is not connected yet, so the protected real API rejects tool calls
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

| Tool          | Purpose                                                        | Inputs                                                                                                                       |
| ------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `search_ads`  | Search ads and return compact summaries.                       | `q`, `niche[]`, `format`, `status`, `started_after`, `brand_id`, `sort`, `limit`, `cursor`, `idempotency_key` (all optional) |
| `get_ad`      | Retrieve full details for one already-identified ad.           | `id` (required, opaque string), `idempotency_key` (optional)                                                                 |
| `list_niches` | Discover valid niche slugs and display names for `search_ads`. | none                                                                                                                         |

`search_ads` follows the v1 search contract: niches are sent as repeated query
parameters (OR within niches), `started_after` is an exclusive calendar boundary,
and `sort=impressions` requires an effective `brand_id` (ranks compare ads only
within that brand). A continuation may inherit its brand from the unchanged
opaque `cursor`. Omitted filters/sort/limit stay omitted so REST applies its own
normalization, cursor inheritance and page-size default. A supplied limit may
change between pages. Empty `niche: []` is rejected: omit it to inherit, or start
a fresh search without a cursor to clear filters.

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
- `get_ad` makes one `GET /api/v1/ads/<encoded-id>` and returns the complete
  REST detail JSON in one text block, including long copy and nulls. IDs are
  encoded as one segment without trimming or numeric interpretation; even exact
  `.` and `..` IDs retain their encoded path rather than becoming another route.
- Optional `get_ad`/`search_ads` `idempotency_key` accepts 1–128 case-sensitive ASCII letters,
  digits, `.`, `_`, `:` or `-`, and is forwarded only as `Idempotency-Key`.
  Omission generates no identity; repeated no-header calls remain separate reads.
  Reusing a supplied key requests REST billing deduplication, not response replay.
- `search_ads` makes one `GET /api/v1/ads`, forwards supplied filter values
  without normalizing or injecting defaults, and preserves the complete REST
  response: summaries (including full headlines/null ranks), normalized filter
  echo, effective sort/limit, next cursor and fixed expiry. REST cursor and
  validation errors retain their envelope; MCP does not restart searches.
- Invalid arguments are rejected by SDK schema validation; `get_ad` and
  `search_ads` reject unknown arguments. Keyword limits count Unicode code points
  after outer whitespace, without altering the forwarded text.
- Integration tests drive the real MCP protocol with the official client and
  a controlled HTTP API fixture; discovery does not make API requests.

**Remaining for M5:**

- Forward the caller's API key as a Bearer credential to the REST API; reuse the
  v1 REST error codes rather than inventing an MCP-specific taxonomy.
- Model evaluation evidence (`MCP_EVAL.md`).

Authentication, authorization, scopes, rate limiting, metering and billing stay
in the REST API. MCP does not retry requests; operational failures may have an
unknown delivery outcome.
