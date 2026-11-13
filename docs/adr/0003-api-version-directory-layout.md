# ADR-0003: Make the directory the API version boundary for `ads`

## Status

Accepted and implemented in [#74](https://github.com/PavelDobranov/gethookd-assignment/issues/74),
a standalone behavior-preserving refactor between accepted M3
([spec #54](https://github.com/PavelDobranov/gethookd-assignment/issues/54),
[plan #55](https://github.com/PavelDobranov/gethookd-assignment/issues/55), both
closed) and M4 (`keys-and-usage`). Scope is the `ads` feature only; no other
feature is versioned.

## Date

2026-11-13

## Context

[V1 search (#54)](https://github.com/PavelDobranov/gethookd-assignment/issues/54)
ships a strict v1 ad-search API that must coexist with a frozen v0 endpoint. As
first built, `apps/api/src/ads/` left the v0 files unmarked at the feature root
(`router.ts`, `query.ts`, `parameters.ts`) and bolted v1 on with a `v1-` filename
prefix (`v1-router.ts`, `v1-query.ts`, …) plus a `V1` tag baked into identifiers
(`createV1Router`, `queryV1Ads`, `parseV1Parameters`, `mapV1AdSummary`,
`sendV1Error`, …).

A prefix is not a namespace. Each new version would re-stamp the prefix across
new files and function names, and v0 stayed privileged as the unmarked original.
The assignment ([#1](https://github.com/PavelDobranov/gethookd-assignment/issues/1))
requires that v0 never break, so the structure that carries versions forward
matters.

## Decision

Make the *directory* the version boundary. v0 files live in `ads/v0/`, v1 files
in `ads/v1/`; the version-independent domain (`model.ts`) and the feature's public
contract (`index.ts`) stay at the feature root `ads/`. Identifiers are
version-free: both routers export `createRouter`, and the v1 helpers drop their
`V1` tag (`queryAds`, `parseParameters`/`normalizeParameters`/`validateParameters`,
`mapAdSummary`/`getAd`, `sendError`/`handleErrors`).

Disambiguation happens once, at the composition root `app.ts`, via import
aliasing:

```ts
import { createRouter as createV0Router } from "./ads/v0/router.js";
import { createRouter as createV1Router } from "./ads/v1/router.js";
```

Adding a future version is purely additive: a new `ads/v2/` folder that renames
nothing existing, imported as `createRouter as createV2Router`. That additive
property is the structural form of the "never break v0" guarantee.

HMAC/AES cursor wire-format constants (e.g. `gethookd:ads:cursor:v1`) stay
unchanged: they are on-the-wire token formats, not code structure. The HTTP
contract and `docs/openapi/v1.yaml` are untouched; internal moves do not change
the wire.

## Rationale and alternatives

- **Keep the `v1-` filename prefix** (rejected): every new version re-stamps the
  prefix and the `V1` identifier tags across files and function names, and keeps
  v0 privileged as the unmarked original. A prefix groups by eye but is not a
  real namespace.
- **Separate top-level features per version** (e.g. `ads-v1/`) (rejected): splits
  the shared, version-independent domain and the public contract across siblings,
  and reads as two features rather than one feature with two versions, which
  spec #54 did not intend.
- **Per-version subfolders within the feature** (chosen): the version is a
  sub-structure *within* `ads`, the shared domain stays at the root, identifiers
  are version-free, and a new version adds a folder without touching the old one.

## Consequences

- Adding `ads/v2/` later renames nothing and leaves v0/v1 untouched; the
  composition root adds one aliased import and one mount.
- This refactor is behavior-preserving. It is guarded by the already-green v0
  contract test, the v1 suites (`v1-search`, `v1-resources`, `v1-parameters`,
  `v1-cursor`, `v1-pagination`, `v1-visibility`, `v1-openapi`) and the OpenAPI
  drift test; all stay green, and error JSON bytes are identical on the wire.
- A separate commit shared the simple `{ error: { code, message } }` envelope
  (`shared/errors.ts`) across the global error handler, health and portal auth.
  v0's frozen `{ error: "Invalid request" }` string and v1's rich envelope
  (`code/message/next_action/retryable/details`) are deliberately left alone.

## Next steps (deferred to M4/M5, not done here)

Per spec #54 ("detailed errors only within v1") and the M4 rate-limit work:

- Promote the **rich v1 error envelope** to `shared/` once MCP (M5) and the M4
  `429` give it a second consumer.
- Extract the **API-key Bearer middleware** (currently the inline authenticate
  handler in `ads/v1/router.ts`) into `api-keys/` for v1 + MCP reuse, once the
  shared rich envelope exists.
- Do **not** merge the portal-JWT handler (`auth/middleware.ts`) with the API-key
  Bearer handler: spec #54 mandates they never cross-authenticate.
