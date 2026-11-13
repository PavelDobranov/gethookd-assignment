# ADR-0005: Exact usage and shared controls via short locked transactions

## Status

Accepted; implemented in M4 (`keys-and-usage`), following the approved
[M4 specification (#76)](https://github.com/PavelDobranov/gethookd-assignment/issues/76)
and [implementation plan (#77)](https://github.com/PavelDobranov/gethookd-assignment/issues/77).
Concurrency and recovery are proven in
[#100 (T16)](https://github.com/PavelDobranov/gethookd-assignment/issues/100); local
and built-stack workflows are verified against isolated environments in
[#109 (T22)](https://github.com/PavelDobranov/gethookd-assignment/issues/109).

Complements [ADR-0001](0001-v0-rate-limit-exception.md), which records the one v0
HTTP 429 exception that consumes the shared allowance defined here.

## Date

2026-11-13

## Context

M4 adds a per-key rate allowance shared across v0, v1 and (later) MCP, exact
current-period usage billing, and reveal-once managed keys — all over a single
PostgreSQL database with independent API pools and processes, and with HTTP
delivery that can drop a response after the server has already committed. The
design had to be correct under concurrency and partial failure while staying the
simplest thing that works for a local demo, not a production-scale service.

The correctness risk is not the arithmetic; it is *where* state is committed
relative to protected work and transport. A limiter or meter that commits after a
read, or that holds a lock across an ad read or a network write, either bills work
it did not admit or serializes the whole system behind slow I/O.

## Decision

Accounting is a set of **short read-committed control transactions** holding narrow
row locks, each committed before any protected work, and never spanning an ad read
or transport.

- **Admission before protected work.** The v1 root owns one Bearer
  authentication/admission boundary before resource scope and input validation;
  v0 admits one query `api_key` before its forgiving parser. Admission takes a
  hash-matching key-row `FOR UPDATE` lock, rejects revoked keys, samples database
  time, and commits before scope, input, read or settlement. Callers must await
  that commit and must not use the standalone credential lookup as a bypass.

- **One authoritative owner aggregate.** Current-period usage lives in a single
  `monthly_usage` row per owner and UTC month. The portal (JWT, free) and the v1
  `keys:manage` usage route read the *same* aggregate and expose identical UTC
  start/end, billed calls, quota and remaining calls. There is no second,
  independently derived meter — in particular no client-side UI counter.

- **Database time and bounded deadlines.** Rolling windows, idempotency expiry and
  settlement all sample database `clock_timestamp()`; a JS `Date` roundtrip never
  decides a cutoff. Control transactions carry local 500 ms lock and 1500 ms
  transaction deadlines on top of the existing 2 s pool/query/statement limits.
  Settlement locks the owner `FOR NO KEY UPDATE` (compatible with key-creation FK
  checks) and never locks a key while holding the owner lock.

- **Bounded lazy cleanup, no background machinery.** The rolling allowance keeps at
  most 60 admission instants, pruning entries older than 60 seconds on each admit.
  Each settlement deletes at most 100 expired idempotency bindings for its own key.
  Idempotency bindings expire semantically at exactly 24 elapsed hours — reuse after
  expiry charges again — but expiry is **not** a physical deletion guarantee: a
  dormant key's expired rows linger until that key sees billing traffic. There is no
  timer, reset scheduler, response-replay store or second UI meter.

- **Retained dormant metadata.** Revoked keys are retained for listing and audit;
  revocation never reduces usage. Historical monthly aggregates and live bindings
  are retained. Bindings store only fingerprint and settlement/expiry data — never
  headers, query bodies, raw URLs, credentials or response snapshots.

## Consequences

- A committed settlement survives lost delivery or a new process/pool. Ambiguous
  commits are never retried automatically: a later same-`Idempotency-Key` request
  resolves the retained binding, while a no-header call is simply another charge.
  Callers that need safe retries must send an `Idempotency-Key`.
- No accounting lock spans an M3 snapshot read or a transport write, so throughput
  is not bound to ad-read or network latency.

### Accepted limitations (not fixed here)

- **Owner serialization.** Settlement serializes per owner by design; this is a
  deliberate throughput ceiling of a simple demo, not a tuned production limiter.
- **No production-scale benchmark.** Correctness is proven by concurrency/recovery
  tests (#100) and workflow verification (#109), not by load testing.
- **Key growth.** Managed keys per owner are unbounded and dormant expired bindings
  are only reclaimed by later traffic on the same key; neither is garbage-collected.
- **Demo JWT.** Portal authentication reuses the existing demo login JWT. It is a
  development fixture, not production-ready authentication, and these JWT routes
  never enter the API-key allowance or return 429.
- **No v1 429.** Only v0 surfaces the shared 429 (ADR-0001); v1 has no 429 response.

## Handoff to M5 (MCP and evaluation)

M5 consumes these controls rather than reimplementing them, and must:

- Reuse the same admission, billing and idempotency primitives over its REST
  backing, and prove REST/MCP parity for admission, billing and error shapes.
- Either propagate a caller-supplied `Idempotency-Key` through MCP tools or
  explicitly document that MCP calls are no-header (each success charges).
- Add Playwright coverage (deferred out of M4) and implement/evaluate the MCP and
  connect setup with the required real-model/client transcripts.

## Alternatives considered

- **A second, independently maintained usage counter (e.g. a UI meter)** (rejected):
  two sources of truth drift; the authoritative aggregate is the only meter.
- **A background scheduler to reset windows and purge expired bindings** (rejected):
  adds operational machinery a local demo does not need; lazy, bounded cleanup on
  the request path is sufficient and keeps expiry semantic.
- **A response-replay store keyed by idempotency value** (rejected): it would cache
  live results and raw responses; carrying only hashed fingerprints and re-reading
  fresh on a matching retry keeps no credential-bearing or stale payload at rest.
- **Admitting per request without a shared durable allowance** (rejected): callers
  could bypass the per-key limit by switching versions or processes.
