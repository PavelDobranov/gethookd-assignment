# ADR-0004: Encode the v1 cursor as a jose + zod trust-token

## Status

Accepted and implemented in [#75](https://github.com/PavelDobranov/gethookd-assignment/issues/75),
a standalone behavior-preserving refactor after accepted M3
([spec #54](https://github.com/PavelDobranov/gethookd-assignment/issues/54),
[plan #55](https://github.com/PavelDobranov/gethookd-assignment/issues/55)) and the
version-directory move ([ADR-0003](0003-api-version-directory-layout.md), #74).

Supersedes the **token-encoding** portion of
[ADR-0002](0002-v1-cursor-visibility.md): the AES-256-GCM envelope and the
field-by-field payload re-validation. ADR-0002's correctness design (insertion
provenance, snapshot visibility, keyset position, exact expiry, error contract) is
retained unchanged.

## Date

2026-11-13

## Context

`apps/api/src/ads/v1/cursor.ts` was 176 lines and the hardest file in the repo to
explain: a hand-rolled AES-256-GCM envelope (nonce/tag/AAD/base64url framing, size
math, version byte) plus ~120 lines of field-by-field payload re-validation
(`validState`/`validQuery`/`validSnapshot`, including calendar-date grammar and
`pg_snapshot` xid parsing).

The cursor's correctness guarantee — no duplicate / no skipped ad while ingest runs
— comes from the `snapshot` + keyset `position` the token carries plus
`visibleAtBoundary()` in `v1/visibility.ts`, **not** from the crypto framing or the
re-validation. Every payload field is server-constructed: `query` from
`parameters.ts`, `snapshot` from `pg_current_snapshot()`, `position` from DB rows,
times from the router. So re-validating the decrypted payload field by field was
re-checking data the server itself had just produced.

`jose` was already a dependency (`auth/jwt.ts`). `zod` is permitted in the API
project and was added here.

## Decision

Make the codec a **trust-token** of two independent concerns:

- **Envelope + authenticity (`jose`).** `EncryptJWT` with `dir`/A256GCM under a
  SHA-256-derived, domain-separated key from the server-only `CURSOR_SECRET`. A
  versioned audience (`gethookd:ads:cursor:v1`) is the format/context guard — bump to
  `:v2` on any payload change and old tokens fail cleanly. The token is authenticated
  encryption under a key only the server holds, so its decrypted contents are trusted
  as *server-issued*.

- **Shape (`zod`).** A single `zod` schema validates the **shape** of the decrypted
  payload (plus the cheap model enums — niche slug, format, status, sort — that come
  free from the `model.ts` constants), so `decode` returns a real typed `CursorState`
  with no unsafe casts, and the public types derive from it via `z.infer`. It does
  **not** re-run the expensive domain refinements (calendar-date grammar, xid parsing,
  niche sort/uniqueness): those fields are server-constructed, so re-checking them was
  the complexity being removed.

Untrusted input is validated where it actually enters the system — `v1/parameters.ts`
— not inside the codec.

### Expiry precision

The router surfaces `cursor_expires_at` from an exact-millisecond `expiresAt` and
`v1-pagination` asserts it is byte-identical across every page. jose's `exp` claim is
second-granularity, so `issuedAt`/`expiresAt` ride as **exact millisecond custom
claims** inside the payload and `decode` enforces `now() >= expiresAt` at millisecond
precision. jose's `exp` is set (rounded **up**, so it never fires before the true
boundary) purely as a coarse backstop.

## Consequences

- `cursor.ts` drops from 176 lines to ~80: no hand-rolled AES framing, size math or
  version byte, and no `issue`/`CursorInput`/`valid*` helpers. `encode`/`decode`
  become `async` (the router handler already was); `v1/router.ts` adds two `await`s.
  `v1/parameters.ts` widens the inbound cursor pre-filter from single-segment
  base64url to the dot-separated JWE charset (`^[A-Za-z0-9_.-]+$`), keeping the 4096
  cap.
- The behavioral contract is unchanged: no-dup/no-skip during ingest (snapshot +
  position carried untouched), one error shape with retryability
  (`INVALID_CURSOR`/`CURSOR_EXPIRED`), tamper/wrong-secret/wrong-audience → sanitized
  `INVALID_CURSOR`, at/after expiry → `CURSOR_EXPIRED`, exact-millisecond expiry and
  stable `cursor_expires_at` across pages. The ingest/visibility correctness suite and
  `v1-pagination` stay green.
- **Known limitation (accepted, not fixed):** the old `encode` hard-failed when a
  token would exceed 4096 characters (e.g. a pathological snapshot with ~1000
  in-flight xids). The jose version has no producer-side cap; an over-long token is
  instead rejected inbound by `v1/parameters.ts` (4096). Realistic snapshots are tiny
  (a few concurrent transactions), so this is acceptable.
- `v1-cursor.test.ts` was rewritten against the public async `encode`/`decode`: the
  byte-format fixtures (fixed-nonce `seal`, byte-flip, noncanonical base64url, the
  producer size cap) and the ~100-case field-by-field re-validation matrix are retired,
  since that responsibility now lives in `v1/parameters.ts` and its tests. Shape
  rejection is proven by sealing a wrong-shaped payload with the real key.

## Alternatives considered

- **Keep the hand-rolled AES-GCM envelope + full re-validation** (rejected): the
  re-validation re-checks server-produced data, and the framing is the single hardest
  thing in the repo to explain, for no correctness that `visibility.ts` does not
  already provide.
- **jose envelope but keep field-by-field re-validation** (rejected): retains the
  complexity being removed; a trust-token under a server-only key makes shape-level
  validation sufficient to produce a sound type.
- **Carry expiry only via jose `exp`** (rejected): second-granularity rounding breaks
  the byte-identical `cursor_expires_at` and the exact-millisecond boundary
  `v1-pagination` asserts.
