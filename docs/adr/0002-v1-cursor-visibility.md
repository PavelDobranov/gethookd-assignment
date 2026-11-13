# ADR-0002: Fence v1 inserts with immutable transaction provenance

## Status

Accepted design in [plan #55](https://github.com/PavelDobranov/gethookd-assignment/issues/55).
Implemented through #56–#69; feasibility and search review gates #58–#70 are
closed. Final milestone acceptance remains a separate human review (#73).

The cursor's **token encoding** (the AES-256-GCM envelope and field-by-field payload
re-validation described in the consequences below) was superseded by
[ADR-0004](0004-v1-cursor-trust-token.md) (#75): a `jose` JWE + shape-level `zod`
trust-token. The correctness design recorded here — `inserted_xid`,
`pg_current_snapshot()`, `pg_visible_in_snapshot`, keyset position, exact expiry and
the `INVALID_CURSOR`/`CURSOR_EXPIRED` contract — is unchanged.

## Date

2026-11-12

## Context

[V1 search (#54)](https://github.com/PavelDobranov/gethookd-assignment/issues/54)
needs a first-page committed-visibility boundary B while later pages read current
status/end dates. Supported ingest inserts ads and deactivates them; IDs, start
dates, brands and ranks do not change. No database connection may remain reserved
for a client walk.

Existing columns cannot establish original insertion visibility:

- Start/discovery dates can be backdated or equal; discovery precedes commit.
- Text IDs and brand-local nullable ranks are not global insertion counters.
  Even a sequence maximum would admit an earlier allocated, later committed insert.
- Tuple `xmin` changes on deactivation and may be a subtransaction ID. Using it
  would lose eligible old rows or misclassify savepoint inserts. Exempting inactive
  rows would admit post-B inserts after deactivation.

## Decision

Keep one internal `inserted_xid xid8 NOT NULL DEFAULT pg_current_xact_id()` column.
Controlled seed/ingest updates preserve it. Existing rows receive the migration
transaction ID; no business/discovery values are rewritten. This records original
insertion membership, not historical insertion times. Manual marker rewrites and
unsupported mutation models are outside this guarantee.

`ads/visibility.ts` captures `pg_current_snapshot()::text` and executes the supplied
page read in one short read-only repeatable-read transaction. It returns only
snapshot text and that read's data, then commits/releases the connection; failures
roll back/release it. Callers must finish database reads inside the callback.

Continuations use fresh reads with
`pg_visible_in_snapshot(ads.inserted_xid, boundary::pg_snapshot)`, live filters and
keyset position. This predicate rejects transactions in flight at B and later
inserts, independently of updates. Fresh PostgreSQL reads supply committed row
values; the predicate alone is not a historical snapshot or a commit-status lookup.
No snapshot export/import, result-ID storage, registry, locks or walk-long
transaction is needed. Snapshot/xid8 values cross the pg/Drizzle boundary as strings;
SQL parameters carry snapshot text without JavaScript numeric conversion.

The default returns a **top-level** transaction ID even within a savepoint.
[PostgreSQL 17 snapshot functions](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-SNAPSHOT)
explicitly warn against passing subtransaction IDs to `pg_visible_in_snapshot`.
[Repeatable read](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-REPEATABLE-READ)
keeps capture and the first page coherent despite intervening commits.

## Consequences and verification

- One additive column is enough under the supported ingest model. It is internal
  metadata, not part of the public ad domain or response allowlists.
- Snapshot text retains no historical tuples or server resources. Current status
  changes can remove active matches or create inactive matches ahead of the walk;
  this is not a frozen result set. Search combines membership with live filters,
  `start_date DESC, id COLLATE "C" ASC` for newest, or brand-local rank ascending,
  nulls last, then the same bytewise ID for impressions. Continuation predicates
  use the same order and handle the known-to-null transition.
- Snapshot size grows with concurrent transactions; the approved bounded cursor
  envelope rejects oversize state rather than truncating it. This limits supported
  snapshot concurrency, not the number of results. Server-generated oversize state
  returns sanitized 500; oversized client tokens return 422 `INVALID_CURSOR`.
- `ads/cursor.ts` encrypts/authenticates normalized filters/sort, snapshot, last
  position and original timestamps with AES-256-GCM: domain-separated SHA-256 key
  derivation, fresh 12-byte nonce, 16-byte tag and authenticated version context.
  The ASCII base64url envelope is bounded to 4096 characters in both directions.
  It contains no credentials or result lists. Authentication precedes decoding;
  authenticated state validation precedes expiry diagnostics.
- Expiry is exactly 30 minutes from page-one start, without renewal. Omitted
  continuation filters inherit originals; equivalent normalized repeats and page
  size changes are allowed, changed query meaning is not. Invalid/tampered or
  wrong-secret tokens return actionable 422 `INVALID_CURSOR`; at/after expiry,
  valid authenticated tokens return `CURSOR_EXPIRED`. Tokens never authorize reads:
  every request checks the stored Bearer API key again and returns no-store.
- A forward walk excludes every post-boundary insert, including in-flight and
  backdated inserts, and returns every initially matching, continuously eligible
  ad once. Deactivation can remove unread active matches; without a status filter
  it does not remove them. Newly matching inactive ads may appear ahead of the
  current position but have no completeness guarantee. Fields/days reflect one
  coherent current page read/time. Replays are allowed, not byte-stable snapshots;
  exhaustion does not subscribe to subsequent changes. Arbitrary ordering-key
  edits, deletion, reactivation and multiple ingest workers are unsupported.
- `CURSOR_SECRET` is separate from JWT/API credentials, server-only and stable
  across API processes sharing database history. Both local setup/dev and Compose
  work without `.env` using the documented public development-only default;
  private overrides require at least 32 UTF-8 bytes. Ordinary same-secret restarts
  preserve unexpired cursors. Secret changes invalidate them; clients start fresh.
  After **any database restore or replacement**, rotate it before serving reads;
  historical transaction provenance cannot safely be carried across histories.
  There is no registry, cleanup worker or retained walk transaction.
- `npm run test:integration -w @gethookd/api -- tests/v1-visibility.test.ts
  --reporter=verbose --silent=false` passes seven real-PostgreSQL tests. Explicit
  transaction ordering proves commit-before/after-B, an in-flight savepoint insert,
  old/equal discovery dates, unchanged markers and live deactivation on both sides
  of B, read-only enforcement, and connection release after success/failure.
- Driver tests round-trip xid8/snapshot strings above JavaScript's safe integer
  range. Mutation checks fail when tuple `xmin` replaces insertion provenance
  (three failures), or inactive rows bypass membership (one failure).
- One disposable PostgreSQL 17.11 run with the 20,000-ad generated seed measured
  2.7 ms for capture plus a 21-row first read, and 5.3 ms for a full membership
  count. Existing 2-second statement/query deadlines remain unchanged. These are
  local feasibility observations, not production-scale benchmarks or full-search
  query plans; no search-order index or 110-million-row performance claim follows.
- Deterministic `v1-pagination.test.ts` exercises real ingest transactions paused
  before commit while page one runs separately, both sorts and live deactivation,
  null/tied traversal, replay/expiry and released connections. These tests prove
  races/backdating; random process smoke results do not.
- On 2026-11-12, #72 exercised actual no-`.env` local and full-Docker startup,
  repeat initialization after live ingest, and M2-to-M3 upgrades on isolated
  PostgreSQL 17.11. Both upgrades backfilled 20,001 evolved ads with one non-null
  migration marker, preserving all business fields/users/keys; new inserts
  received their current top-level transaction ID by default. Real API process
  restarts preserved tokens; recreating an API with a different secret returned
  actionable `INVALID_CURSOR`, and fresh searches worked. See the
  [README workflow evidence](../../README.md#m3-workflow-verification) for commands,
  process observations, isolation differences and verification limits.
