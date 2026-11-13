# DESIGN

GetHookd v1 and MCP. For how AI was used to build this project, see [AI notes](AI_NOTES.md).

The milestone specs and the decisions behind them live in these GitHub issues:

- [GetHookd — Technical assessment](https://github.com/PavelDobranov/gethookd-assignment/issues/1) — the assignment
- [Milestone specification](https://github.com/PavelDobranov/gethookd-assignment/issues/2) — the roadmap
- [M1 specification — Foundation and protected portal](https://github.com/PavelDobranov/gethookd-assignment/issues/3)
- [M2 specification — Representative world, preserved v0 and basic API key authentication](https://github.com/PavelDobranov/gethookd-assignment/issues/34)
- [M3 specification — Strict v1 search and stable REST contracts](https://github.com/PavelDobranov/gethookd-assignment/issues/54)
- [M4 specification — Keys, exact usage and functional Developer Portal](https://github.com/PavelDobranov/gethookd-assignment/issues/76)
- [M5 specification — MCP integration and real-model evaluation](https://github.com/PavelDobranov/gethookd-assignment/issues/118)

## Trade-offs

- **Node.js/Express instead of Laravel/PHP.** I chose it because I know it well and it fits the time
  budget, not because it is better. The project uses TypeScript, npm workspaces and Biome, with three
  apps: `apps/web` (React/Vite), `apps/api` (Express/Drizzle/PostgreSQL 17) and `apps/mcp`
  (Streamable HTTP).
- **One API, and MCP built last.** `apps/mcp` only talks to `apps/api` over HTTP. I built it after
  REST auth, errors, rate limits and billing were stable. REST is the single source of truth for
  scopes, revocation, limits and metering. MCP just passes the caller's key to REST on each request.
  The cost is one extra network call. The benefit is that the auth and billing rules stay in one place.
- **PostgreSQL for everything, no extra services.** Rate limits and billing are stored in Postgres.
  This keeps the number of moving parts low. The trade-off is that the database is the main limit on
  speed (see scaling).
- **Billing is saved before the answer is sent.** If the response is lost, the caller can retry with
  the same `Idempotency-Key` and will not be charged twice. The key is optional, works for 24 hours,
  and is tied to one API key.
- **Kept simple where the assignment allows.** Portal login is one seeded user with a JWT that does
  not expire, kept in `sessionStorage`; logout only clears the token in the browser. This is fine for
  a local demo, not for production. The MCP result-size limit and the Playwright E2E tests were cut
  for time, and I say so clearly instead of hiding it.

## How v0 and v1 live together

v0 stays exactly as it was, and a contract test keeps it that way. It ignores unknown parameters,
ignores invalid filter values, accepts niche display names, uses page/offset paging with `per_page`
capped at 100, sorts by `start_date` with no tiebreaker, takes `api_key` in the query string, and
returns `400 {"error":"Invalid request"}` for every error, even a bad key.

v1 runs next to it under `/api/v1`. It is strict: it rejects unknown parameters and bad values and
suggests the likely fix (`nich`→`niche`, `Skincare`→`skincare`). It echoes back the filters it
actually used. It sorts in a stable way: ads with no impression data come last, and `impressions`
sorting needs one `brand_id`. It uses cursor paging that stays correct while new ads arrive. It has
one error shape: a code, a message, what to do next, and whether a retry helps. The same key works on
both: query string for v0, `Authorization: Bearer` for v1.

Three things are shared so the two versions cannot drift apart: one store of hashed keys, one rate
limit and billing meter, and one way to work out `days_active`. The only places v0 breaks its old rule
are the shared limits it never had before: `429` with `Retry-After` for rate limiting, and the monthly
quota, where v0 keeps its `400` and v1 returns a clear "quota used up" error with the reset time.

## Shipping a breaking change to v1

I would use the same idea that lets v1 sit next to v0. Small, safe changes (a new optional filter, a
new field) go straight into v1. A real breaking change (a renamed field, or a new default sort) ships
as a new `/api/v2`, and v1 keeps working. I would tell callers that v1 is going away, give them time
to move, watch the meter to see who still uses v1, move the MCP tools to v2, and turn v1 off only when
no one uses it. Rollback is easy: turn v2 off, and v1 is untouched.

## What's next (most important first)

1. Limit the size of MCP search results, and keep `get_ad` for full detail. This is still missing.
2. Add Playwright end-to-end tests for the portal (login → create key → use it → see usage → revoke).
3. Fix the two speed problems listed in the last section before the number of ads grows large.

## The first two parts that break at ~110M ads / 5–6M active

1. **Keyword search.** Both v0 and v1 search `q` as a text "contains" match. This cannot use a normal
   index, so at ~110M ads it has to read the whole table and becomes slow. **Fix:** use a proper text
   search index in Postgres, or move keyword search to a search engine built for this while Postgres
   still holds the real data. v0 also returns a full `total` count, which gets too slow at this size,
   so I would show an estimated count instead.

2. **Billing and rate limits in Postgres.** Each user has one counter row for their monthly quota, and
   every paid call locks and writes to that row. With millions of active ads and a lot of agent
   traffic, that one row becomes a queue, and the write slows down every request. **Fix:** split the
   counter into several rows and add them up, keep the fast rate-limit check in memory, and write the
   billing in the background while still charging each call exactly once.
