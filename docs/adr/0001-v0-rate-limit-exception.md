# ADR-0001: Allow v0 rate-limit failures to use HTTP 429 in M4

## Status

Accepted; implementation deferred to M4 (`keys-and-usage`). This records the
confirmed decision in the approved [M2 specification (#34)](https://github.com/PavelDobranov/gethookd-assignment/issues/34),
not a change to current runtime behavior.

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

When M4 implements shared rate limiting, **v0 rate-limit failures will return
HTTP 429 with an accurate `Retry-After` as an explicit exception to the legacy
HTTP 400 rule**. The wait must reflect the shared per-key allowance, not a
separate v0 allowance.

All existing v0 errors remain generic HTTP 400 with
`{"error":"Invalid request"}` in M2, including missing/invalid keys, invalid
pagination, duplicate recognized parameters and unexpected database failures.
No rate-limit middleware, exception behavior or future-behavior tests are added
in M2. M4 owns exception implementation, rate-limit tests and the corresponding
v0 regression-contract update. This decision does not authorize changing other
v0 errors or adopting v1's error envelope for them; it does not specify a new
v0 rate-limit response body.

## Rationale and alternatives

- Keeping HTTP 400 for rate-limit failures would preserve the literal v0 rule,
  but violate the shared-rate-limit requirement and hide the standard signal
  that callers should wait before retrying.
- Exempting v0 from the limiter would preserve its error behavior, but let callers
  bypass the shared per-key allowance by switching API versions.
- The narrow HTTP 429 exception honors shared enforcement and gives callers an
  accurate retry delay without redesigning the rest of the legacy contract.

## Consequences

- In M4, clients that assume every v0 error is HTTP 400 must also handle HTTP 429
  and honor `Retry-After`; this is an intentional compatibility exception, not
  a claim of fully unchanged error behavior.
- Existing v0 quirks and non-rate-limit error behavior remain preserved. M2's
  current contract tests stay unchanged and remain a regression gate.
- M4 must carry this ADR into its regression-contract update and prove shared
  rate limiting and accurate retry timing. M5 must verify MCP parity with those
  shared controls. Recording the decision here does not implement either milestone.
