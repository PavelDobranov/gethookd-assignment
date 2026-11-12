# ADR-0002: Fence v1 inserts with immutable transaction provenance

## Status

Accepted design in [plan #55](https://github.com/PavelDobranov/gethookd-assignment/issues/55).
The database primitive is implemented and tested in #56/#57; human feasibility
review at #58 remains required before subsequent cursor/HTTP work.

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
  this is not a frozen result set. Keyset/expiry/token guarantees require later
  tasks, not this primitive alone.
- Snapshot size grows with concurrent transactions; the approved bounded cursor
  envelope must reject oversize state rather than truncate it. Restore/replacement
  requires cursor-secret rotation. Encryption, validation and the 30-minute expiry
  belong to subsequent tasks; no HTTP/token implementation is claimed here.
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
