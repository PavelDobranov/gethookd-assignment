# ADR-0006: Bounded retry of admission under self-inflicted row-lock contention

## Status

Accepted. Refines [ADR-0005](0005-exact-usage-and-shared-controls.md) (short locked
control transactions with 500 ms lock / 1500 ms transaction deadlines). Resolves the
root-cause investigation in
[#112](https://github.com/PavelDobranov/gethookd-assignment/issues/112), observed
during #103/#104 M4 verification.

## Date

2026-11-13

## Context

Admission (ADR-0005) takes a hash-matching key-row `FOR UPDATE` lock in a control
transaction before any protected work. A burst of concurrent requests on the **same
key** therefore serializes on that one `api_keys` row: this is correct and is what
enforces the exact 60-admission rolling allowance.

The `http-accounting` cohort test fires 64 simultaneous requests at one key and
asserts exactly 60 × 200 and 4 × 429. It passed in isolation but was observed to
fail once during full M4 verification with 60 × 200 but only 2 × 429 — two requests
were neither admitted nor denied.

Reproduction (64-request cohort repeated under load, all outcomes captured)
confirmed the mechanism:

- Anomalies occur **only** in cohorts whose wall time balloons from the ~500–900 ms
  norm to ~1.7–2.5 s — a transient PostgreSQL stall (checkpoint / fsync), not a
  stuck lock.
- The lost requests fail with a codeless socket error on the `SELECT … FOR UPDATE`
  query: the backend was terminated by the **1500 ms `transaction_timeout`**, not by
  the 500 ms `lock_timeout` (which would surface SQLSTATE `55P03` and a clean,
  reusable rollback). Each individual lock wait stays under 500 ms; it is the
  *total* transaction age that crosses 1500 ms while the request is legitimately
  queued behind a briefly-stalled holder.
- Because the tail of the queue is exactly where denials live, the requests lost to
  fail-closed 500s are the ones that should have returned 429 — hence "60 admitted,
  fewer than 4 denied, the remainder 500."

The 500/1500 deadlines are a deliberate, tested contract (`accounting-locks` pins
them and the layering beneath the 2 s pool limits), so widening the budget is not an
option — and a large enough stall would defeat any fixed budget anyway.

## Decision

Admission retries its own control transaction a **bounded** number of times
(`MAX_ADMISSION_ATTEMPTS = 5`) when an attempt fails, with small random jitter
between attempts to decorrelate a synchronized cohort.

An attempt is retried **only** when it both *entered* its control transaction (a
connection was checked out and the transaction body began) and did *not* reach the
decisive `COMMIT` hand-off. Two flags, `entered` and `decided`, bound the retry:

- **Fail-closed before the transaction body is preserved.** A failure at connection
  checkout or before the body runs (`entered` false) — a database that cannot be
  reached — propagates as a sanitized 500 exactly as before. This is the established
  contract pinned across `v0`, `v1-openapi` and `v1-resources`, which inject a
  one-shot `connect()` failure and require a 500, and it is the reason the retry is
  scoped to the transaction body rather than wrapping the whole call.
- **An ambiguous commit is never replayed.** The rolling-window append is
  non-idempotent, so once the decisive `UPDATE` is handed to `COMMIT` (`decided`
  true) a failure propagates rather than risk double-counting. This keeps ADR-0005's
  "ambiguous commits are never retried automatically" invariant intact.

Scoping by transaction stage — rather than by error identity — distinguishes the two
contention shapes without inspecting fragile, sometimes absent SQLSTATEs (the
dominant burst failure is a codeless terminated-session error):

- **Transient self-contention (a burst, possibly during a stall).** Attempts are
  aborted pre-commit (`transaction_timeout`, and any `lock_timeout` / serialization
  / deadlock), so they retry and resolve to a real 200/429 once the stall clears.
- **A genuinely held key lock.** Every attempt's `FOR UPDATE` trips the 500 ms
  `lock_timeout` and never commits, so the bounded attempts are spent and the
  request still fails closed with the state unchanged.

The control-transaction deadlines, settlement, and the idempotency contract are
unchanged. Settlement is **not** retried: its ambiguity is a committed-but-unknown
billing outcome, which callers resolve with an `Idempotency-Key` (ADR-0005).

## Consequences

- The 64-request cohort is deterministic: 150 repetitions under induced stall load
  (cohorts up to ~2.5 s) produced zero anomalies, versus a reproducible failure rate
  before.
- Fail-closed behavior and exactly-60 admissions are preserved. A persistently held
  key lock now fails closed after up to five 500 ms lock waits (~2.5 s) instead of
  one; the outcome is identical, the latency of that pathological case is higher. In
  production nothing holds an `api_keys` row `FOR UPDATE` for seconds (admission is
  short; revocation is a single quick `UPDATE`), so this cost is paid only by the
  synthetic held-lock test, which stays within its timeout.
- The retry lives in the admission path only, so v0 and v1 both inherit it through
  the shared `admitApiKey` boundary.

### Accepted limitations

- The attempt bound is empirical, chosen to span the worst stalls observed on the
  test container with margin, not derived from a load model. An extreme, sustained
  stall longer than the combined attempt budget would still fail closed — correctly,
  but visibly.
- The retry does not reduce contention; it absorbs it. The per-owner / per-key
  serialization ceiling of ADR-0005 is unchanged.

## Alternatives considered

- **Widen the 500 ms / 1500 ms control-transaction deadlines** (rejected): they are
  a tested contract layered beneath the 2 s pool limits, and no fixed budget
  survives an arbitrarily long stall.
- **Retry only on specific SQLSTATEs (e.g. skip `55P03` to keep the held-lock case
  fast)** (rejected): the dominant burst failure is a *codeless* terminated-session
  error with no SQLSTATE, and a stall can in principle present a burst waiter as
  `lock_timeout` too, so a code-based predicate is both unreliable and unsafe. The
  `reachedCommit` boundary is the real safety property.
- **Collapse admission to a single locked statement to shrink the critical section**
  (rejected as insufficient alone): it trims a round trip but cannot beat a
  multi-hundred-millisecond stall, so it would reduce the failure rate rather than
  eliminate it.
- **Weaken the cohort assertion or the fail-closed test** (rejected): explicitly out
  of scope for #112; the product behavior, not the test, was wrong.
