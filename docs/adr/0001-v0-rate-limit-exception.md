# ADR-0001: Allow v0 rate-limit failures to use HTTP 429 in M4

## Status

Accepted; implemented in M4 (`keys-and-usage`, #97), following the approved
[M2 specification (#34)](https://github.com/PavelDobranov/gethookd-assignment/issues/34)
and M4 specification #76.

## Date

2026-11-12

## Context

The [assignment (#1)](https://github.com/PavelDobranov/gethookd-assignment/issues/1)
requires preserving v0, including HTTP 400 with `{"error":"Invalid request"}`
for every error, even a bad key. It also requires a per-key limit of 60 requests
per minute shared across v0, v1 and MCP, returning HTTP 429 with an accurate
`Retry-After`. These requirements conflict for v0 rate-limit failures.

The [milestone roadmap (#2)](https://github.com/PavelDobranov/gethookd-assignment/issues/2)
identified this compatibility conflict for resolution in M2. The approved M2
specification records the confirmed resolution and defers shared controls to M4;
MCP will consume those controls when introduced in M5.

## Decision

**v0 rate-limit failures return
HTTP 429 with an accurate `Retry-After` as an explicit exception to the legacy
HTTP 400 rule**. The wait must reflect the shared per-key allowance, not a
separate v0 allowance.

The 429 body is the shared rich `RATE_LIMITED` envelope: `error` contains
`code`, `message`, `next_action`, `retryable: true` and `details: []`.
Both guidance strings state the same integer wait as `Retry-After`.

All other v0 errors remain generic HTTP 400 with `{"error":"Invalid request"}`,
including missing/invalid/revoked or duplicate credentials, scope, pagination,
idempotency-header/conflict, quota and unexpected failures. A single usable query
credential authenticates and enters the shared allowance before protected
validation, even for unsupported paths/methods. Supported search keeps its
forgiving parser, query, ordering and success shape; billing uses its effective
parameters. This does not authorize adopting strict v1 validation.

## Rationale and alternatives

- Keeping HTTP 400 for rate-limit failures would preserve the literal v0 rule,
  but violate the shared-rate-limit requirement and hide the standard signal
  that callers should wait before retrying.
- Exempting v0 from the limiter would preserve its error behavior, but let callers
  bypass the shared per-key allowance by switching API versions.
- The narrow HTTP 429 exception honors shared enforcement and gives callers an
  accurate retry delay without redesigning the rest of the legacy contract.

## Consequences

- Clients that assume every v0 error is HTTP 400 must also handle HTTP 429
  and honor `Retry-After`; this is an intentional compatibility exception, not
  a claim of fully unchanged error behavior.
- Existing v0 quirks and non-rate-limit error behavior remain regression gates.
  Mixed-version HTTP tests cover shared admission and billing; low-level admission
  tests cover exact rolling boundaries. M5 still must verify MCP parity.
