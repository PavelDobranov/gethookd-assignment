# @gethookd/mcp

MCP server for GetHookd. It exposes GetHookd ad search to MCP clients (AI agents)
over **Streamable HTTP**, calling the REST API (`apps/api`) over HTTP — never
the database directly.

All three tools are HTTP-backed, and each tool invocation forwards the caller's
own `Authorization: Bearer <key>` to the corresponding REST request. No shared key
or API bypass is provided; REST remains the sole authority for key validity,
scopes, revocation, rate limits and billing.

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

### Claude Code

Add this server to Claude Code with the HTTP transport, passing your own
reveal-once API key as the Bearer credential:

```bash
claude mcp add --transport http gethookd http://127.0.0.1:3001/mcp \
  --header "Authorization: Bearer <YOUR_API_KEY>"
```

The protected portal's **Connect Claude Code** panel shows this same secret-free
template with a copy button; substitute your `search:read` key for the
placeholder. A literal key in shell history or client config must be protected and
never committed — prefer an environment reference (`Bearer $GETHOOKD_API_KEY`)
where your client supports it.

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
- All tools reject invalid/unknown arguments with a JSON `VALIDATION_ERROR`
  envelope and parameter-specific guidance from their shared discovery schemas.
  Public SDK dispatch/result projection supports the 2025 and 2026 protocol eras;
  malformed framing remains a protocol failure, not a REST admission.
  Keyword limits count Unicode code points after outer whitespace, without
  altering the forwarded text.
- Valid REST failures preserve their complete JSON envelope, including rate wait
  and quota reset guidance. Malformed upstream responses, network failures,
  timeouts and unexpected local exceptions become sanitized `INTERNAL_ERROR`
  tool results. Delivery may already have settled billing: deliberate search/detail
  retries should reuse the same supplied `idempotency_key`; without one, another
  successful call can charge again. MCP never retries automatically.
- Root `npm test` explicitly runs MCP, API unit/isolated PostgreSQL integration,
  and web tests. No suite is optional.
- Integration tests drive the real MCP protocol with the official client and
  a controlled HTTP API fixture; discovery does not make API requests.
- An API-side suite (`@gethookd/api` `tests/mcp-auth.integration.test.ts`, in the
  isolated-PostgreSQL gate) runs a real MCP client against a real MCP server
  forwarding to the real REST API: a `search:read` key exercises every tool, a
  `keys:manage`-only key fails with `INSUFFICIENT_SCOPE`, a valid portal session
  JWT substituted for an API key and absent/malformed/unknown credentials are
  classified as `UNAUTHENTICATED`, and revoking a key through the REST key API
  blocks the next MCP call. Fixtures live in the API tests, not MCP code.
- A second API-side suite (`@gethookd/api`
  `tests/mcp-controls.integration.test.ts`, same isolated-PostgreSQL gate) proves
  mixed MCP/direct-REST accounting against the single REST meter: search and
  detail successes charge (including empty searches and each cursor page) while
  `list_niches` and failed reads do not; equal no-header successes charge
  separately and the API (`/api/v1/usage`) and portal (`/api/portal/usage`) reads
  agree with the meter. A supplied `idempotency_key` deduplicates across both
  channels on one key — including a synchronized concurrent cohort that settles
  once — a changed request reusing the identity conflicts with
  `IDEMPOTENCY_CONFLICT` on either channel, and different keys keep independent
  namespaces. A deduplicated retry returns current data for free, and MCP calls
  without a supplied key generate no implicit identity (no second meter, no
  JSON-RPC/session dedup). The same suite proves the remaining shared controls:
  mixed v0 (query-credential), v1 (Bearer) and MCP traffic consumes one shared
  per-key allowance, appending exactly one admission per valid call on any channel;
  free `list_niches` calls and admitted-then-failed reads consume allowance while
  protocol-only connect/discovery exchanges do not; and an exhausted allowance
  propagates REST's live `RATE_LIMITED` wait through MCP unchanged. An exhausted
  owner quota refuses a new billable MCP success with `QUOTA_EXCEEDED` and reset
  guidance, while an existing matching billed retry still deduplicates for free and
  free or failing reads pass their own checks rather than the quota check.

**Authentication:** each caller sends `Authorization: Bearer <API key>` on the MCP
request. The server reads Node's raw headers before SDK normalization and accepts
exactly one well-formed Bearer header, forwarding it unchanged to REST per
invocation. A missing, malformed or duplicate header is answered locally with
`UNAUTHENTICATED` guidance and reaches no REST call; an unverified key is never
presented to the SDK as validated auth. Credentials are request-scoped, never
stored, cached, logged, placed in tool arguments or carried in URLs, and
concurrent callers stay isolated.

**Remaining for M5:**

- Model evaluation evidence (`MCP_EVAL.md`).

Authentication, authorization, scopes, rate limiting, metering and billing stay
in the REST API. MCP does not retry requests; operational failures may have an
unknown delivery outcome.
