# GetHookd

An ad-intelligence platform

## Local development

Prerequisites: the Node.js version in `.nvmrc`, npm, Docker Engine, and Docker
Compose supporting `up --wait`. Ports 5432 (PostgreSQL), 3000 (API), and 5173
(Vite) must be available. No `.env` file is required.

```sh
npm ci
npm run setup
npm run dev
```

Open `http://localhost:5173`; the API is at `http://localhost:3000`. Sign in with
`demo` / `demo-password` to see the server-verified username and Log out.
Refresh revalidates the session through `/api/auth/me` before displaying it.
`/` enters the auth flow: without a token it resolves to `/login`; a verified
session resolves to `/portal`. Direct visits, refresh, browser Back and restored
back-forward-cache pages revalidate before displaying protected content.
The built-web Docker workflow below provides the same routes at port 8080.

`setup` starts **only** Compose `db`, waits up to 30 seconds for healthy TCP
readiness (120-second overall provisioning deadline, including image acquisition),
then runs the shared committed-migration → world-seed initializer with a 60-second
deadline. It never generates migrations or launches API, Vite or Studio. Repeats
preserve all data and existing credentials. Run initializers sequentially, not in
parallel. On timeout, cancellation or failure, later stages do not run; diagnostics
identify readiness versus initialization without printing child SQL/credentials.
Existing database storage is never deleted, including on failure.

`npm run dev` starts only local API/Vite watchers; it does not start PostgreSQL,
migrate, seed or launch Studio. Run setup first and stop conflicting services
before starting dev. Stop watchers with Ctrl+C; `docker compose stop db` stops
PostgreSQL without deleting storage. `docker compose down` also preserves storage.

Explicit root commands forward to installed workspace-local tooling:

```sh
npm run db:generate  # Generate migrations for review/commit, never during startup
npm run db:migrate   # Drizzle Kit applies committed pending migrations only
npm run db:seed      # Add missing demo user, brands, ads and public key; preserve data
npm run ingest       # Explicit single-process live ingest; initialize the database first
npm run db:studio    # Explicit local Studio, 127.0.0.1:4983; stop with Ctrl+C
```

Studio connects to the configured database and prints its browser entry URL.
It is never started by setup, dev, build, tests or default Compose services.
All database commands share the configuration precedence described below.

## Complete Docker workflow

Requires Docker Engine and Docker Compose v2 supporting dependency conditions;
host Node/npm, `.env`, `node_modules` and `dist` are not required.

```sh
docker compose up --build
```

Open `http://localhost:8080` and sign in with `demo` / `demo-password` (unless
that user's password was deliberately changed). PostgreSQL must become healthy
before the one-shot `setup` service applies committed migrations and seeds the
world. Setup must exit successfully before API startup; API health gates the built
web server.
A failed setup blocks API/web startup: inspect `docker compose logs setup` and
correct configuration/readiness rather than deleting data. There is no Studio
service. DB/API/web published ports bind to loopback only (5432/3000/8080).

Nginx serves compiled React assets, proxies `/api` and `/api/…` internally to the
API, and serves the SPA for `/portal` deep links and refresh. Unknown API paths
retain the API's 404 response, never the SPA fallback. `/api/auth/me` failures
retain JSON errors/statuses. Auth responses remain non-cacheable.

### Credential-safe Nginx logging

The built-web Nginx server explicitly sets `access_log off;` and
`error_log /dev/null;`, inherited by every location without overrides. This
local-demo policy intentionally discards access and request-error diagnostics:
native error logs can include raw URLs containing `api_key`, even when access
logging is disabled. Do not re-enable location logging or rely on Nginx logs to
diagnose request/upstream failures. Startup/configuration diagnostics are not
guaranteed to remain available either. Application logging remains sanitized;
never log keys, raw request URLs or raw database errors.

`npm run test:unit -w @gethookd/api -- tests/logging-config.test.ts` pins the
server directives/inheritance, API proxy paths/status forwarding and SPA fallback.
Runtime verification checks the effective built Nginx configuration and scans
application/Nginx output after v0 success, rejection and upstream failure using
public test sentinels only. See [M2 workflow verification](#m2-workflow-verification)
for measured results; do not publish raw key-bearing requests or private secrets.

```sh
docker compose down           # Stop/remove containers and network, KEEP DB data
docker compose up --build     # Reapply pending migrations; preserve users/data
```

Local development and the complete stack are alternative workflows. Before
switching from local development, stop API/Vite watchers (Ctrl+C). Before switching
back, run `docker compose down`, then `npm run setup` and `npm run dev`. Both paths
reuse the persistent database volume; neither resets credentials. An explicit
`DATABASE_URL` must match the selected execution context; unset it to derive the
appropriate host/container default. Never use volume deletion to switch workflows.

Images build from the committed lockfile and source; `.dockerignore` excludes host
dependencies, build output, `.env*` and key files. The API runs as the unprivileged
Node user with production dependencies, compiled code and committed migrations.
Setup uses the same image and compiled shared initializer, including Drizzle ORM's
runtime migrator; it needs neither Drizzle Kit nor TypeScript tools at runtime.
The container entrypoint calls the shared configuration loader in container context
before launching either entry point. The web runtime contains only Nginx and built
assets, not Vite/Node or server configuration. These are development/demo images,
not a production deployment.

Manual Docker verification used an isolated clean source snapshot with no host
`node_modules`, `dist` or `.env`. `docker compose up --build -d` brought up the
system at `localhost:8080`; a test-only override disabled the DB's host port to
leave an existing developer database untouched. In isolated Chromium, direct
`/portal`, keyboard login, refresh, logout and logged-out refresh worked, with
no console/runtime errors. `/portal` returned the SPA, unknown `/api` returned the
backend 404 (not SPA HTML), and unauthenticated `/api/auth/me` returned JSON 401.
After `down` then `up --build -d`, demo ID/exact hash and an unrelated test user
were byte-for-byte unchanged. Separate fresh-volume runs verified custom database
credentials (including reserved password characters), a custom JWT secret, and an
explicit encoded URL with a query option observed on actual database connections.
An unreachable explicit URL and an explicitly empty URL both failed setup with
API/web left unstarted. Test-owned resources were cleaned up; developer data was
not modified.

Packaging references: [Compose dependency conditions](https://docs.docker.com/compose/how-tos/startup-order/),
[Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/),
and [Nginx proxy URI handling](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

## API development and verification

Use Node.js from `.nvmrc` and install workspace dependencies with `npm ci`
from the repository root. Full tests require a running Docker Engine and Docker
Compose with `up --wait` support, plus access to the `postgres:17` image (pulled
on first use).

```sh
npm run dev -w @gethookd/api    # API only, with reload on source changes
npm run test -w @gethookd/api   # Required unit + disposable PostgreSQL suites
npm run test:unit -w @gethookd/api  # HTTP/config/password tests, no Docker
npm run test:integration -w @gethookd/api  # Real PostgreSQL 17; Docker required
npm run build -w @gethookd/api
npm run start -w @gethookd/api  # run the compiled API after building
```

The API listens on `0.0.0.0:3000`. `GET /api/health` returns HTTP 200 with
`{"status":"ok"}` only after a successful PostgreSQL query. Connectivity failures
return generic HTTP 503 `SERVICE_UNAVAILABLE`; health responses use
`Cache-Control: no-store`. Unknown API routes outside v1 return Express's HTTP 404
response, not a frontend SPA page; v1 uses the structured errors described below.

```sh
curl -i http://localhost:3000/api/health
```

`apps/api/src/app.ts` exports `createApp({ db, jwtSecret, cursorSecret? })` without
opening a listener or connecting/migrating/seeding the database. Omitting
`cursorSecret` uses the exported public development default; the runtime server
explicitly passes the loaded configuration. `src/server.ts` loads
server-only configuration, owns the database pool and listener, and closes them
on SIGINT/SIGTERM. Tests use native fetch against a new
loopback listener on an ephemeral port per test and close it after each test.
Tests live outside `src/` and are not included in the production build.

## v1 niche discovery

`GET /api/v1/niches` returns `{ "data": [{ "slug": "skincare", "name": "Skincare" }, ...] }`:
exactly the existing 12 niches in catalog order, with no keywords, counts or
pagination. It accepts no query parameters. Use the same stored API key as v0,
now in one `Authorization: Bearer` header:

```sh
curl -i http://localhost:3000/api/v1/niches \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2'
```

Each request checks PostgreSQL again; stored-key changes take effect on the next
request. Query-string keys and portal JWTs cannot replace Bearer API keys. All v1
successes and errors have `Cache-Control: no-store`. Authentication runs before
path/query validation, so missing or invalid credentials receive 401 rather than
protected diagnostics. No request URLs, keys, cursors or raw database errors are
logged by this boundary.

Errors have exactly these fields (wording may vary):

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "A valid Bearer API key is required.",
    "next_action": "Provide a stored API key in Authorization: Bearer <key>.",
    "retryable": false,
    "details": []
  }
}
```

Current codes are `UNAUTHENTICATED` (401), `NOT_FOUND` (404, unknown route or
method), `AD_NOT_FOUND` (404, missing ad), `VALIDATION_ERROR` (422, unsupported resource query parameters or malformed
path encoding or a decoded NUL in an ad ID), and `INTERNAL_ERROR` (500, including database failure). Only 500
is retryable, after a short delay. Validation details contain `parameter`,
`reason`, `allowed_values` and nullable `suggestion`; this endpoint accepts no
query parameters, so its allowed-values list is empty. Unsupported HEAD returns
404 headers without a body, as required by HTTP. v0 and portal errors are unchanged.
Search additionally returns `INVALID_CURSOR`, `CURSOR_EXPIRED` and
`CURSOR_QUERY_MISMATCH` (422); retain the original query/token or start a fresh
search as directed. The [OpenAPI contract](docs/openapi/v1.yaml) is checked against
actual HTTP responses; rate limiting remains M4 work.

### v1 filtered search

`GET /api/v1/ads` accepts only `q`, repeated `niche`, `format`, `status`,
`started_after`, `brand_id`, `sort`, `limit` and `cursor`. Unknown names, duplicate
scalars, invalid/empty enums, noncanonical niches, impossible dates and limits
outside 1–100 return actionable 422 errors rather than silently broadening search.
NUL characters in `q` (including URL-encoded `%00`) also return 422 before querying.
Keyword whitespace is trimmed (case preserved); matching is case-insensitive on
headline OR body, with literal `%`, `_` and backslash. Repeated niches combine
with OR, deduplicate and sort; every other filter combines with AND. Dates are
strict `YYYY-MM-DD`, with **exclusive** `start_date > started_after` matching.

```sh
curl -sS -G http://localhost:3000/api/v1/ads \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2' \
  --data-urlencode 'q=serum' --data-urlencode 'niche=skincare' \
  --data-urlencode 'niche=haircare' --data-urlencode 'started_after=2026-01-01' \
  --data-urlencode 'limit=2'

# Rank 1 first within one brand; unknown ranks last. Not cross-brand impressions.
curl -sS 'http://localhost:3000/api/v1/ads?sort=impressions&brand_id=1&limit=2' \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2'
# Missing brand_id intentionally produces 422 with a correction.
curl -i 'http://localhost:3000/api/v1/ads?sort=impressions' \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2'

# Exclusive boundary: ads starting ON 2026-10-04 do not match.
curl -sS 'http://localhost:3000/api/v1/ads?started_after=2026-10-04' \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2'
# Impossible calendar dates intentionally return actionable 422, not rollover.
curl -i 'http://localhost:3000/api/v1/ads?started_after=2026-02-30' \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2'

# Paste next_cursor from a response; omitted filters inherit the original query.
CURSOR='<next_cursor>'
curl -sS -G http://localhost:3000/api/v1/ads \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2' \
  --data-urlencode "cursor=$CURSOR" --data-urlencode 'limit=10'
```

Responses contain `data` (the detail summary fields only, excluding body, end date,
countries and discovery timestamp), normalized `applied_filters` (`q`, `niche`,
`format`, `status`, `started_after`, `brand_id`), `sort`, effective `limit` (default
20), nullable `next_cursor` and fixed UTC `cursor_expires_at`. Absent keyword is
`""`, niches `[]`, other absent filters null. Empty/final pages have null cursors;
empty pages retain the effective filters and expiry. No total or internal
insertion marker is exposed.

Default `newest` orders across brands by date descending, then bytewise ID
ascending. `impressions` requires one brand and orders rank ascending, nulls last,
then the same bytewise ID. Rank 1 is highest within that brand; gaps are retained,
not renumbered. Null means unknown, not zero. Ranks are not impression counts and
cannot compare impression magnitudes across brands or identify the highest-impression
brand. Known ranks are unique within a brand; equal ranks in different brands do
not imply equal impressions.

To correct `sort=impressions` without a brand, add one known `brand_id` (as in the
curl example above), or use `sort=newest` to search across brands. A valid but
nonexistent brand returns an empty result, not a validation error. For niche
corrections, replace `niche=Skincare` with `niche=skincare`, or
`niche=Pet%20Supplies` with `niche=pet-supplies`; discover canonical values through
`GET /api/v1/niches`. Corrections are advisory and never applied silently.

Continuations may change page size or repeat equivalent normalized filters, but
changed query meaning returns `CURSOR_QUERY_MISMATCH`. Tokens expire exactly 30
minutes after page one, never renew, remain replayable and never replace auth.

A short repeatable-read first page establishes insertion eligibility; continuations
read live state while excluding all later-committed inserts, including backdated
and already-in-flight inserts. Under supported ingest (inserts/deactivation, fixed
ordering keys), forward walks do not repeat or skip initially matching ads that
remain eligible. Unread deactivated ads disappear from active-filter searches but
remain in unfiltered searches. Newly matching inactive ads have no completeness
guarantee; start a fresh search for a new complete set. Each response computes days
from one current UTC time, not the first-page clock. Exhaustion does not subscribe
to later changes.

Focused verification: `npm run test:integration -w @gethookd/api -- tests/v1-pagination.test.ts tests/v1-visibility.test.ts tests/v1-search.test.ts`
passes 56 HTTP/PostgreSQL tests covering filter-sensitive fixtures, both sort
walks, rank 1/gaps/cross-brand equal ranks, many bytewise null IDs, known-to-null
and all-null pages, size changes, in-flight/later known and null insertion
exclusion, live deactivation and newly inactive positions, normalized continuation,
replay, UTC rollover, fixed expiry, per-request authentication and sanitized
no-store errors.

The controlled-ingest proof runs real `runIngestTick` transactions with injected
time/randomness. A test-only wrapper pauses after all writes but before commit;
page one completes on another connection while that transaction is still open.
A later transaction commits before the boundary, defeating a max-xid shortcut.
Both sorts exhaust small/changing pages for active, inactive and unfiltered
searches while further ticks insert current/backdated ads and deactivate old and
post-boundary ads. Assertions check ordered, exact continuously eligible coverage,
no repeated IDs and exclusion even after later inserts become inactive. Newly
inactive rows have no completeness assertion. No process sleeps establish ordering.

Replays read live fields, agree with v0/detail at the same UTC time/state across
midnight, retain exact expiry and continue after recreating the HTTP app with an
independent pool. PostgreSQL session checks find no retained transactions between
requests; a real timed-out first-page query rolls back under the unchanged
two-second query/connection deadlines and leaves the pool usable. Disabling the
insertion-visibility predicate makes all six controlled walks fail; restoring it
passes. Removing the null-only continuation guard also fails on duplicate IDs.
No production correction was needed. The cursor unit suite passes 95 tests.
Actual-process ingest and OS-process restart checks are recorded separately in
[M3 workflow verification](#m3-workflow-verification). Neither these deterministic
checks nor the smoke runs establish production-scale performance.

### v1 OpenAPI contract

[OpenAPI 3.1](docs/openapi/v1.yaml) defines search, detail and niche discovery,
Bearer authentication, strict inputs, response allowlists and current errors.
Repeated niches use `style: form` with `explode: true`, not commas or brackets.
The impressions/brand cross-field rule and live cursor guarantees are documented
alongside the schemas. Rate limiting/429 remains M4 work.

Run `npm run test:integration -w @gethookd/api -- tests/v1-openapi.test.ts` for
real HTTP/PostgreSQL checks against the artifact using test-only YAML, Ajv2020 and
format validation. The suite checks populated/empty/null responses, every current
error code, request constraints and filter-sensitive fixtures. Drift probes reject
incompatible required fields, enums, statuses and nested schemas; changing the
artifact's sort enum to an unsupported value also makes the actual HTTP check fail.
The root `npm test` includes this suite. Existing v0 and portal contracts are unchanged.

### v1 ad detail

`GET /api/v1/ads/:id` reads the current ad joined with its brand, independently of
search cursors. Encode the exact opaque string ID as one URL path segment; IDs
are not numbers and are not trimmed or normalized. No query parameters are accepted.

```sh
curl -i 'http://localhost:3000/api/v1/ads/seed-ad-000001' \
  -H 'Authorization: Bearer gethookd-public-demo-api-key-m2'
```

The response is `{ "data": { ... } }` with exactly `id` (string), `brand_id`
(integer), `brand_name`, `headline`, `niche` (slug), `format`, `status`,
`start_date`, `days_active`, `impression_rank` (integer or null), `body_text`,
`end_date` (date or null), `countries` (ISO-2 array), and `discovered_at` (UTC ISO
timestamp). Dates use `YYYY-MM-DD`. Active days use the response's current UTC
date; inactive days use the end date. Missing IDs return `AD_NOT_FOUND` with
instructions to check the ID from search. Authentication, no-store, query
rejection and sanitized server-error behavior match niche discovery.

Focused verification: `npm run test:integration -w @gethookd/api -- tests/v1-resources.test.ts tests/v0.test.ts`
checks real HTTP/PostgreSQL authentication, exact catalog/response allowlists,
next-request key changes, duplicate credentials, isolated 401/404/422/injected-500,
legacy compatibility, full active/inactive detail allowlists, exact encoded IDs,
UTC midnight/v0 agreement, and detail-query failures after authentication.

## Server configuration

`apps/api/src/config.ts` exports `loadConfig()` for server/database consumers.
It reads the optional repository-root `.env` independently of the working
directory, then applies exported environment variables (including explicit empty
values, which fail validation). It does not mutate `process.env` or expose
configuration to Vite. Missing `.env` is supported; other file-read failures are
reported without revealing contents.

Defaults are `gethookd` for `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB`, plus separate public development-only JWT and cursor secrets.
The `CURSOR_SECRET` default is
`gethookd-public-development-cursor-secret-do-not-use-in-production`.
`JWT_SECRET` and `CURSOR_SECRET` overrides must each be at least 32 UTF-8 bytes. Empty,
whitespace-only or control-character-containing settings fail with the variable
name, never the value. `DATABASE_URL` must be a PostgreSQL URL with a host and
database name.

Without `DATABASE_URL`, `loadConfig()` derives an encoded URL at
`localhost:5432`; container callers use `loadConfig({ context: "container" })`
for `db:5432`. An explicit URL is preserved exactly, never rewritten for a
context. The database client and Drizzle commands use this server-only boundary.

### Optional environment overrides and Compose

Copy `.env.example` to `.env` only if overrides are needed. Both the server loader
and Compose use the root file with exported values taking precedence. Use literal
single-quoted values for reserved characters (`#`, spaces, `$`); interpolation
inside `.env` values is not supported by the server loader. Explicit URL
credentials and database names must be percent-encoded; derived URLs do this
automatically. Do not set `DATABASE_URL=` to mean unset: remove the setting.

- Host URL example: `postgresql://gethookd:gethookd@localhost:5432/gethookd`.
- Container URL example: `postgresql://gethookd:gethookd@db:5432/gethookd`.

A localhost override cannot reach the host database from an application container.
An explicit URL changes the application/setup target, not the credentials of a
separate database. Drizzle commands and local setup use the same server loader
in host context; API/setup containers select container context.

Compose's PostgreSQL 17 service uses `POSTGRES_*` defaults or overrides, a
healthcheck using the configured user/database, persistent storage, and port 5432
bound to `127.0.0.1`. API/setup receive those values plus optional `DATABASE_URL`
and the independent `JWT_SECRET` and `CURSOR_SECRET` from the exported environment
or root `.env`. Absent overrides
stay absent so the shared loader derives defaults; explicit empty values are not
replaced with defaults. The web receives none of these settings.
Explicitly empty database initialization values fail at
container startup instead of silently choosing defaults. To inspect configuration
without starting services, run `docker compose config` (its output includes
configured credentials: do not share it or run it in public logs with real secrets).

**Existing-volume limitation:** PostgreSQL initialization variables apply only to
a fresh volume. Changing `.env` does not rename databases/users or reset existing
passwords. `docker compose down` preserves the volume. Keep overrides consistent
with its existing credentials, or deliberately administer the existing database;
never delete a developer volume to make a configuration change work.

These credentials and both default secrets are public development fixtures.
Production requires separate private JWT and cursor secrets, non-demo credentials, HTTPS, and an
authentication hardening review. No server settings use the `VITE_` prefix or are
imported by the web app.

### Cursor secret operations

`CURSOR_SECRET` is server-only configuration passed through server/app/v1 router
composition for the search cursor codec. Never
reuse `JWT_SECRET` or API-key material, and never prefix this setting with `VITE_`
or pass it to the web build. Neither startup path
requires a `.env` file or manual secret setup for local development.

To generate a private override, run `openssl rand -hex 32` and store the output as
`CURSOR_SECRET` in the optional root `.env` or your server's secret environment.
The same override is selected by `npm run dev` and `docker compose up --build`.
Do not commit it, print it in logs, or share resolved Compose configuration.

The v1 cursor contract requires a stable secret across ordinary API restarts and
all API instances sharing a database. Retaining the same
secret and database history preserves otherwise valid, unexpired cursors; changing
the secret invalidates existing cursors and clients must start fresh searches.
After any database restore or replacement, rotate `CURSOR_SECRET` before serving
requests, even if restoring the same database name. Restart host API processes or
recreate API containers (`docker compose up -d --force-recreate api`) to apply the
new value. Do not rotate `JWT_SECRET` as a substitute. No in-memory key registry or
rotation UI is involved.

The internal codec (`apps/api/src/ads/cursor.ts`) uses Node AES-256-GCM with a
SHA-256-derived, domain-separated key, fresh 12-byte nonces, 16-byte tags and
authenticated version context. Tokens carry only normalized query/sort, insertion
snapshot, last position and original issue/expiry times—not credentials or result
lists. `issue` starts a 30-minute lifetime using the injected clock; continuation
code must use `encode` on decoded state with an updated position, preserving the
original times. `decode` authenticates before validating state or reporting expiry.
Tokens can be replayed; they never authorize a request.

Both input and output are limited to 4096 ASCII base64url characters. Invalid,
unsupported, tampered or wrong-secret tokens raise sanitized `INVALID_CURSOR`;
at or after expiry, authenticated valid tokens raise `CURSOR_EXPIRED`. Both require
an unmodified valid token or a fresh search, not a silent restart. Oversized
server-generated state fails explicitly rather than truncating the snapshot; this
bounds supported concurrent snapshot metadata, not the result count. Search maps
these errors to the v1 HTTP 422 envelope.

Focused verification: `npm run test:unit -w @gethookd/api -- tests/v1-cursor.test.ts`
covers both sorts, null ranks, replay/reconstruction, tampering, authenticated
payload validation, nonce variation, exact size/expiry boundaries and retained
original expiry with deterministic clocks.

## Disposable PostgreSQL integration tests

`npm test` requires API unit tests, a separate PostgreSQL integration run, and web
component tests. Each command must collect tests and succeed; missing Docker,
failed provisioning, readiness timeout, and empty/failing suites are errors, never
skips. PostgreSQL suites run one file at a time to avoid contention between real
scrypt hashing and seed persistence on the shared test server; all tests and
deadlines remain in force. Use
`npm run test:unit -w @gethookd/api -- tests/password.test.ts` to focus a unit file
without provisioning PostgreSQL.

Integration global setup uses **only `compose.test.yaml`**, a random
`gethookd-test-<UUID>` Compose project, an isolated labeled volume/network, and a
dynamic loopback port. It never reads `DATABASE_URL` or uses the developer Compose
stack. The disposable database/user is `gethookd_test`; the test performs a real
SQL query and verifies PostgreSQL 17 and that database identity. Project names
are printed for inspection; connection credentials are public test-only values.

Docker commands have deadlines: provisioning is capped at 120 seconds (including
image acquisition) and health readiness at 30 seconds; SQL connections/queries
are limited to two seconds. The TCP healthcheck avoids mistaking PostgreSQL's
temporary initialization server for final readiness. Test pools close after the
suite. Global teardown runs on test failure as well as success; failed setup also
attempts cleanup. Before deleting resources, cleanup inspects project and run-ID
labels, then removes only that generated project's containers, network and volume.
It never prunes or runs `down` against the developer project.

If Docker becomes unavailable during cleanup or the process is force-killed,
resources can remain: restore Docker, inspect the printed project/run-ID labels,
and remove **only that verified disposable project** with its test Compose file.
Never delete a developer volume to repair test startup. No background database
container is required before running the suite.

## User schema and committed migrations

```sh
npm run db:generate -w @gethookd/api  # Generate SQL/metadata for review and commit
npm run db:migrate -w @gethookd/api   # Apply committed migrations to configured DB
npm run db:seed -w @gethookd/api      # Add missing demo user, world fixtures and key
npm run test -w @gethookd/api -- tests/db.test.ts  # Isolated migration/read/write tests
```

The migration workspace scripts invoke the installed Drizzle Kit with
`--config=drizzle.config.ts` from `apps/api`; no tool download is needed.
Start the local database first (`npm run dev:db`) before applying migrations.
Commands use root `.env` / exported configuration as described above. Migration
application is repeatable and preserves records; generation is developer-only,
never performed by startup. Do not use schema push. Review generated SQL and
metadata in `apps/api/drizzle/` and format metadata with Biome before committing.

`src/db/schema.ts` defines UUID primary keys generated by PostgreSQL, unique
non-null usernames and non-null password hashes. `createDatabase(databaseUrl)`
in `src/db/client.ts` returns a Drizzle `db` and async `close()`; callers own the
pool and must close it on shutdown or test teardown. Connection acquisition,
client query waits and PostgreSQL statements each have a two-second timeout.
Protected query timeouts return unavailable errors rather than bad credentials.
Idle connection failures
are handled with a sanitized diagnostic so the process can recover on later
queries rather than crash. Importing the module does
not connect, migrate or seed. Drizzle query builders / SQL template parameters
keep values separate from SQL.

The database integration suite applies the real workspace-local migration CLI
against an initially empty disposable PostgreSQL database, checks read/write
behavior, constraints, and repeat application. Only `src/` is compiled into the
API runtime; tests and Drizzle Kit configuration remain outside runtime output.

Drizzle Kit's development-only dependency chain currently reports four moderate
npm audit findings from an older transitive esbuild (GHSA-67mh-4wv8-2f99). The
advisory concerns esbuild's development server, which these generate/migrate
commands do not launch. Do not expose such a server; no forced downgrade or
unreviewed dependency override is applied.

### Repeat-safe world and demo seeding

After migrations, run `npm run db:seed -w @gethookd/api`. Public local credentials
are username **`demo`**, password **`demo-password`**; only a randomly salted
scrypt hash is stored. Use `POST /api/auth/login` to authenticate. The explicit command uses
the same configuration loader, closes its pool on success or failure, and exits
nonzero with a safe diagnostic if configuration or database access fails. It does
not generate or apply migrations. No passwords, hashes or connection URLs are
printed.

`src/db/seed.ts` exports shared `seedDatabase(db)`, used by both `db:seed` and
the initializer, plus the user-only `seedDemoUser(db)` primitive. Imported callers
retain ownership of their database connection. The shared operation inserts the
missing demo user, 300 brands, 20,000 ads and public API-key hash in one
transaction. It resolves the actual existing demo ID and preserves existing key
records, including their IDs and owners. Any persistence failure rolls back the
entire seed; it never reports partial seed success. `src/db/initialize.ts` owns one
pool and uses Drizzle's PostgreSQL migrator to apply the same committed SQL/history as
Drizzle Kit, then seeds and closes the pool even on failure. Migration paths are
resolved from the module, independently of the working directory, for source and
compiled execution. Both local setup and the one-shot Compose setup entry point
use this initializer; API startup never imports or runs it.
Database uniqueness and insert-on-conflict handling leave an existing demo ID and
exact hash untouched. Repeated seeding and setup never reset
a deliberately changed password or change unrelated users. The documented demo
password therefore stops working if someone deliberately changes it.

```sh
npm run test:integration -w @gethookd/api -- tests/seed.test.ts tests/db.test.ts
npm run test:integration -w @gethookd/api -- tests/world-seed.test.ts tests/seed.test.ts
```

`world-seed.test.ts` compares complete ordered brand/ad records from two fresh,
independently migrated and seeded databases, including discovery timestamps,
with exact counts/distributions, keywords and per-record invariants. Salted user
hashes and generated key UUIDs are intentionally excluded from fresh-world equality.
Repeat initialization and seeding preserve evolved credentials, key owners/IDs,
modified/deactivated/backdated ads and unrelated records. PostgreSQL record-text
comparisons retain timestamp microseconds. Deleting a highest-ranked fixture and
inserting an ingest-shaped row at that rank restores the missing fixture above
the brand's maximum without changing existing rows; another seed is a no-op.
A late-batch uniqueness conflict proves world/brand rollback rather than silent
conflict-skipping. Rank repair can reach `2147483647`; exhaustion beyond that
PostgreSQL integer limit fails with full rollback, never wrapping or using null.
These fixtures simulate ingest; [M2 workflow verification](#m2-workflow-verification)
also checks complete-row preservation after running the actual ingest command.

Tests use a separate database inside the disposable PostgreSQL project, covering
empty/repeated seeding, changed credentials/world rows, missing fixtures, occupied
rank repair and two real seed/initializer CLI runs with ID/hash preservation.
Country validation rejects malformed arrays and invalid ISO-2 members. A late
key-insert failure proves full transaction rollback and sanitized nonzero command
exit. Unmigrated-database and invalid-configuration checks also require prompt
nonzero exits without exposing sensitive details. Tests report actual timings for
the 40 batches of 500 ads; two-second query/statement limits stay in force.
Each batch binds one JSON payload and uses PostgreSQL's
[`jsonb_to_recordset`](https://www.postgresql.org/docs/17/functions-json.html)
to expand typed ad rows. This avoids thousands of ORM bindings per batch while
retaining country validation, database constraints and transaction-wide rollback.

## Deterministic ad-domain fixtures

`apps/api/src/db/fixtures.ts` provides pure `generateFixtures()` data: 300 brands
(IDs 1–300) and 20,000 ads (`seed-ad-000001` through `seed-ad-020000`). Each call
resets xorshift32 to `0x47484b44` and uses a fixed **2026-10-05** reference date,
never the current clock. Start dates span **2024-10-05 through 2026-10-04**;
discovery timestamps are fixed UTC instants on the reference date. Exactly 12,000
ads are active and 8,000 have null impression ranks. Fixtures cover all 12 niches,
their headline keywords, all three formats, and valid uppercase ISO-2 countries.
Known ranks are positive and unique within each brand; gaps/nulls are intentional,
and equal ranks across brands do not imply comparable impressions.

`apps/api/src/ads/model.ts` owns the catalog, country validation, and reusable
`daysActive(ad, now?)`: whole UTC calendar days from start to today's UTC date
for active ads, or to the end date for inactive ads. This derivation uses actual
current time by default, independently of the fixed fixture reference date, and
is not stored on ads.

```sh
npm run test:unit -w @gethookd/api -- tests/ads-model.test.ts tests/fixtures.test.ts
```

These tests cover UTC boundaries, invalid countries, complete fixture equality
under different clocks, exact distributions, keywords and per-record invariants.
The generator does not write to PostgreSQL. Setup and `db:seed` persist its
fixtures through the shared transactional `seedDatabase(db)` operation.
It validates fixture country arrays, inserts missing brands/ads in batches of 500,
and stores the public key's hash against the actual demo user. Existing rows are
never updated. Missing known-rank fixtures retain a free desired rank, or receive
a deterministic fallback above both stored and full-fixture maxima; rank
exhaustion fails and rolls back rather than renumbering or dropping fixtures.
v0 HTTP authentication uses the stored hash on every request. The atomic ingest
operation below evolves this world without resetting fixtures.

## Live ingest

After successful setup/initialization, run in a separate terminal:

```sh
npm run ingest
# Ctrl-C to stop; SIGTERM is also supported.
```

The root command forwards to the API workspace CLI and uses the same server-only
configuration as other database commands (root `.env`, overridden by exported
variables such as `DATABASE_URL`). It never migrates or seeds. API startup,
setup, dev and Compose do not launch it automatically. Run only one ingest process
against a database; concurrent workers/processes are unsupported. Stop ingest
before running setup/seed again.

The first tick starts after one second. Each completed tick is followed by another
one-second wait, so slow ticks never overlap or trigger catch-up bursts. SIGINT
and SIGTERM cancel future scheduling, let the in-flight transaction finish or
roll back, then close the database pool. Configuration, database and tick failures
exit nonzero with `Ingest failed.`; cleanup failure uses
`Ingest database shutdown failed.`. Diagnostics never include raw errors or URLs.
There is no automatic retry or distributed-worker coordination.

### Atomic tick

`apps/api/src/ingest/tick.ts` exports Express-independent
`runIngestTick(db, { clock?, random? })`. Defaults use the current clock and
`Math.random`; tests supply a clock and controlled draws in `[0, 1)`. Each tick
uses one UTC time snapshot for dates and discovery timestamps, not the seed's
reference date. It requires migrated storage and existing brands.

One transaction selects 1–2 distinct random active ads that existed before the
tick and started on/before today, deactivates the available remainder with today's
UTC end date, and inserts 1–5 active ads with `ingest-ad-<UUID>` IDs. Same-tick
inserts cannot be deactivated. Each insert uses an existing brand and the domain
niche/format catalog; country-array shape and every ISO-2 member are validated
before persistence. Draws below 0.30 backdate by 1–90 inclusive UTC days; otherwise
the start date is today. Draws below 0.40 select a null rank; known ranks append
above that brand's maximum, including inactive ads and earlier same-tick inserts.
Existing ranks never change. Reaching rank `2147483647` is allowed; exhaustion
fails the whole transaction rather than wrapping, renumbering or substituting null.
Any failure rolls back all inserts and deactivations.

```sh
npm run test:unit -w @gethookd/api -- tests/ingest.test.ts tests/ingest-runner.test.ts
npm run test:integration -w @gethookd/api -- tests/ingest-db.test.ts
```

Controlled tests cover probability thresholds, UTC boundaries, available candidate
counts, valid new ads, brand-local allocation, integer exhaustion and real
PostgreSQL rollback after an injected failure or invalid generated countries.
The tick itself has no timer, listener or startup side effects. Runner tests use
an injected clock/tick to prove serial cadence, shutdown draining and sanitized
failure/cleanup paths. Actual-process tests use isolated PostgreSQL to observe
inserts/deactivation, both shutdown signals, released connections and sanitized
failure through the root command; they never wait for random backdating.

## Legacy v0 parameter contract

`GET /api/v0/ads?api_key=gethookd-public-demo-api-key-m2` serves the legacy
contract. `apps/api/src/ads/router.ts` uses the raw query parser in `parameters.ts`
and validates the supplied key against PostgreSQL on every request; portal JWTs
cannot substitute. Responses are not cached. All v0 failures, including database
failures, return exactly HTTP 400 `{"error":"Invalid request"}` locally, without
changing portal/health errors or logging raw errors, keys or request URLs.

The accepted [v0 rate-limit exception ADR](docs/adr/0001-v0-rate-limit-exception.md)
records an **M4-only** compatibility exception: rate-limit failures will return
HTTP 429 with accurate `Retry-After`. M2's generic 400 behavior and contract tests
remain unchanged; exception implementation, rate-limit tests and the regression
contract update belong to M4.

Success is `{"data":[...],"page":1,"total":123}`. Each ad contains only string
`id`, brand name `brand`, `headline`, niche display name `niche`, `format`,
`status`, `start_date` (`YYYY-MM-DD`) and integer `days_active`. Days use the
actual current UTC day for active ads and the end date for inactive ads, not the
seed reference date. `total` counts all filtered ads before pagination; beyond-end
pages return empty data and the requested page. SQL orders only by
`start_date DESC`, without a tiebreaker or snapshot guarantee. Live changes and
ties can produce duplicates/gaps across offset pages; this is intentional v0
behavior. Headline/body search uses bound parameters and escapes `%`, `_` and
backslash as literals, never wildcard or SQL syntax.

Only exact names `q`, `niche`, `format`, `status`, `page`, `per_page`, and
`api_key` are recognized. Repeating any recognized name fails, even with empty
values. Unknown names (including `sort`, bracketed `niche[x]`, and repeated
unknown names) are ignored. Use the raw URL query, not Express's nested query
object, to preserve this distinction.

- `q` is preserved as a literal substring, including spaces, `%` and `_`;
  missing/empty means match all. Case-insensitive matching belongs to the query.
- `niche` accepts a slug or display name case-insensitively, without trimming.
  `format` and `status` accept only exact case-sensitive catalog values.
  Empty/invalid filters omit only that filter; valid filters remain combined.
- `api_key` must be one nonempty scalar; its value is preserved without trimming.
  Parsing does not prove the key exists in storage.
- Missing pagination defaults to `page=1`, `per_page=20`. Values must contain
  only ASCII decimal digits and represent positive safe integers (leading zeros
  are accepted). Empty, zero, negative, fractional, whitespace, exponent,
  partial-numeric and unsafe values fail. Valid `per_page` values above 100 clamp
  to 100 **before** calculating `(page - 1) * per_page`; unsafe offsets fail too.
  The typed result uses `perPage`, `page`, and `offset` internally.

```sh
npm run test:unit -w @gethookd/api -- tests/ads-parameters.test.ts
npm run test:integration -w @gethookd/api -- tests/v0.test.ts tests/login.test.ts tests/identity.test.ts tests/health.test.ts
```

The HTTP suite uses an isolated PostgreSQL database and discriminating fixtures
for filters, pagination boundaries, duplicate raw names and stored-key changes.
It also exercises real auth/count/row-query failures and checks application
output for credential-bearing errors without changing portal error contracts.

## Ad and API-key storage

The append-only `0001_lucky_next_avengers.sql` migration adds `brands`, `ads`,
and `api_keys` without changing `users` or its existing data. Both initialization
paths apply committed migrations; generation remains an explicit development step.

`brands` has an integer ID and required name. `ads` has a stable text ID and a
required brand reference, headline/body, niche, format, status, start date,
country-code array and UTC discovery timestamp. PostgreSQL checks catalog
membership, positive-or-null impression ranks, active/null versus inactive/required
end dates, and end dates on/after start dates. Known ranks are unique per brand;
multiple nulls and equal ranks in different brands remain valid. Country membership
is validated in the application, not through a database country table.
`days_active` remains derived and is not a column.

`api_keys` stores only a generated UUID ID, required user reference, and unique
required `key_hash`; no plaintext or lifecycle metadata is stored. Foreign keys
prevent deletion of a referenced brand/user rather than silently removing ads/keys.
The migration provides storage; the stored-key operations below provide hashing
and validation. The shared seed inserts the public development key's hash;
v0 HTTP authentication uses the stored-key operations below.

```sh
npm run test:integration -w @gethookd/api -- tests/db.test.ts tests/world-model.test.ts
```

The disposable PostgreSQL tests exercise accepted/rejected constraints, typed
fixture round-trips, empty-database migration, M1 upgrades with exact user
preservation, and migration replay preserving world data. Ledger checks compare
all committed SQL hashes and journal timestamps and retain exact replay equality.
No developer database is used.

## Stored API-key operations

`apps/api/src/api-keys/index.ts` exports `hashApiKey(key)` and
`validateApiKey(db, key)`. Hashing uses Node crypto SHA-256 with lowercase
hexadecimal output. Store only the digest and the actual owning user's ID in
`api_keys`; never store or log the raw key. Validation accepts a nonempty string
without trimming or case folding and performs a parameterized PostgreSQL lookup
on every call, with no credential cache. It returns `{ userId }` for a matching
stored hash or `null` for missing, empty, non-string or unmatched input. Database
failures propagate; callers must map them to sanitized errors, never successful
authentication or raw database diagnostics. Portal JWT authentication is separate
and unchanged.

The public development fixture is **`gethookd-public-demo-api-key-m2`**, whose
SHA-256 digest is
`58d113adf87d5116295338f827abb725a35bf732a31f85d465d9bf2f112fca47`.
It is public, development-only, and not a production secret. Setup and `db:seed`
insert its hash if missing; the key authenticates `GET /api/v0/ads`. No key
management HTTP endpoint is available. Future managed
keys require cryptographically random secrets; these operations add no key management,
scopes, rate limits or metering.

```sh
npm run test:unit -w @gethookd/api -- tests/api-key-hash.test.ts
npm run test:integration -w @gethookd/api -- tests/api-keys.test.ts
```

The isolated PostgreSQL tests verify hash-only storage and actual ownership,
invalid input, changed/deleted hashes and owners between calls, and failure after
a previously successful lookup loses its database connection.

## Password hashing primitive

`apps/api/src/auth/password.ts` provides async `hashPassword` / `verifyPassword`
for seed and future login consumers. Native Node scrypt
uses a fresh 16-byte salt, a 64-byte key, and the OWASP baseline `N=131072, r=8,
p=1` (~128 MiB per derivation; 256 MiB memory ceiling). The stored format is
`scrypt$N$r$p$saltHex$keyHex`; verification accepts only this bounded cost profile
and uses a timing-safe key comparison. Malformed hashes and wrong passwords
return false. Passwords must contain 1–1024 JavaScript string characters and are
not trimmed or normalized. Neither passwords nor hashes are logged or returned
by HTTP routes. Seeding alone never starts the API or issues tokens.

## Credential login API

`POST /api/auth/login` accepts JSON `{ "username": "demo", "password":
"demo-password" }`. A successful response is HTTP 200 with
`{ "token": "<JWT>", "user": { "id": "<string>", "username": "demo" } }`.
Only those user fields are exposed. Matching is case-sensitive and exact;
username and password are not trimmed or normalized. Existing changed demo
credentials are honored, not reset.

Credentials must be nonempty strings, at most 100/1024 JavaScript string
characters for username/password respectively. Additional fields are ignored,
never copied into the user or token. The JSON body is limited to 16 KiB;
compressed request bodies are rejected. All auth responses use
`Cache-Control: no-store`.

Errors use `{ "error": { "code": "...", "message": "..." } }`:

- 400 `INVALID_REQUEST`: malformed/oversized JSON or unsupported encoding.
- 422 `VALIDATION_ERROR`: missing body or invalid credential field shape/length.
- 401 `INVALID_CREDENTIALS`: identical generic error for unknown usernames and
  wrong passwords; no token is returned.
- 503 `SERVICE_UNAVAILABLE`: database connection/readiness/resource failure.
- 500 `INTERNAL_ERROR`: unexpected failure, including schema/query errors.

Errors never expose request bodies, SQL, hashes or connection details; the API
does not log credentials or tokens. `jose` signs HS256 using server-only
`JWT_SECRET`; the only payload claim is the stable database user ID in `sub`.
There is deliberately **no expiration, refresh token, session store or
revocation**. A copied token remains valid indefinitely with the same signing
secret and existing user, even after client logout or an API restart. This is
an approved local-demo limitation, not production authentication. Protected
identity lookup is available as `GET /api/auth/me`; public `GET /api/health`
checks PostgreSQL readiness.

`GET /api/auth/me` accepts only `Authorization: Bearer <JWT>`. Each request
verifies an HS256 signature and UUID subject, then resolves the current user
from PostgreSQL. Success returns only `{ "user": { "id": "<string>",
"username": "demo" } }`; missing/invalid tokens and deleted subjects return
401 `UNAUTHENTICATED`. Cookies/query parameters never authenticate. Responses
are not cached; database outages return 503, not 401, and unexpected errors
remain sanitized. Changing `JWT_SECRET` invalidates old tokens.

```sh
npm run test -w @gethookd/api -- tests/identity.test.ts tests/health.test.ts
```

```sh
npm run test:integration -w @gethookd/api -- tests/login.test.ts
```

These real HTTP/PostgreSQL tests use a separate database in the disposable test
project. They verify seeded login, signature/claims/secret overrides, no expiry
after advancing verification time, exact credentials, field boundaries,
parameterized lookup, safe errors and no-cache responses. Never print successful
login bodies or Authorization headers in logs or documentation.

Manual smoke verification of the built local API against a disposable seeded
PostgreSQL instance confirmed 200 login, 401 bad credentials, 503 while the
database was stopped, and successful login after database restart without
restarting the API. Response shape/string IDs and absence of credentials/tokens
in API logs were checked without printing the token. Existing host services and
developer data were left untouched; disposable resources were cleaned up.
Manual checks of the built API also confirmed identity 401 without a token,
200 with a login token, health/identity 503 with PostgreSQL stopped, and recovery
of both endpoints after restarting PostgreSQL without restarting the API.

## Web authentication boundary

`apps/web/src/auth.ts` exports typed `login(credentials)` and `getIdentity(token)`
functions using relative `/api/auth/login` and `/api/auth/me` URLs. Responses are
validated and reduced to JWT and public user fields (`id`, `username`). Identity
comes from the server, never decoded claims. Requests omit cookies, disable cache
and reject redirects; protected requests carry the token only in a Bearer header.
`AuthError.kind` distinguishes `unauthenticated` (401), `unavailable` (network/5xx),
`request` (other HTTP failures), `invalid_response`, and `storage`. Errors are
sanitized; there are no automatic retries or implicit auth-state transitions.

UI consumers explicitly call `storeToken`, `readToken`, and `clearToken` to persist
only the JWT under `gethookd.auth.token` in `sessionStorage`. Malformed stored values
are removed; missing values return null, and blocked storage reports a storage
error. A restored token's shape is not proof of authentication: revalidate it with
`getIdentity` before rendering protected content. No credentials or identity are
persisted; localStorage and cookies are not used. The connected login form supports
keyboard submission, required fields, pending status and generic errors. It clears
the password field on submission and checks `/me` before saving the returned JWT
and rendering the username. Restored sessions show a loading state until verified;
401 removes the token, while network/server failures show an unavailable state
without automatic retries. Retry explicitly revalidates the retained token; Log out
clears the token and in-memory identity and replaces the route with `/login`.
Navigation, logout and unmount invalidate pending responses so they cannot restore
an obsolete session.
Normal tab closure ends that tab's storage session, but browser session restore or
duplicated tabs may preserve/copy it. Browser-readable storage is vulnerable to
XSS; removing a token does not revoke a copy, and cross-tab logout is not guaranteed.

```sh
npm run test -w @gethookd/web -- src/auth.test.ts
```

These tests mock only HTTP boundaries and use real jsdom sessionStorage semantics;
no browser E2E tooling is introduced.

## Web component tests

```sh
npm run test -w @gethookd/web   # Vitest + jsdom + React Testing Library
```

Component tests render the real app with HTTP-boundary mocks and explicitly clean
up the DOM after each test. They cover keyboard login/logout, JWT-only persistence,
server-verified username, pending/error states, restoration, 401, unavailable
service/manual retry, blocked storage, route transitions, Back/cache restoration
and late responses after navigation, logout or unmount.

```sh
npm run test -w @gethookd/web -- src/app.test.tsx
```

Local runtime verification: `npm run setup` and `npm run dev` succeeded. In an
isolated Chromium profile, keyboard login as demo displayed only `demo` and Log out;
refresh restored demo, logout returned to login, and another refresh stayed logged
out. Screenshots were inspected; no horizontal overflow occurred at widths
320/768/1024/1440px and no console/runtime errors were observed. No Playwright or
browser E2E suite is installed; E2E automation remains deferred until the full
frontend is implemented.

Navigation/recovery runtime checks in an isolated Chromium profile through Vite
confirmed direct unauthenticated `/portal` → `/login`, login → `/portal`, refresh,
and logout then browser Back without protected content returning. A fresh tab
without an opener and a new tab after closing the authenticated tab both required
login. Blocking the identity request showed unavailable without automatic retries;
unblocking and clicking Retry recovered. Stopping the local API produced a Vite
proxy 5xx and the same unavailable state; restarting it and clicking Retry restored
the verified session. No runtime exceptions were observed; the portal screenshot
contained only the username and logout control. Browser restore/duplicated-tab
storage caveats above still apply; these checks do not imply token revocation.

`npm test` explicitly requires API unit, PostgreSQL integration, and web suites,
stopping with a nonzero exit for a missing workspace/test script, zero collected
tests, a failed prerequisite, or a failing test.
`npm run build` builds and type-checks both workspaces; `npm run lint` runs Biome
lint, and `npm run check` runs Biome checks across `apps/` and `scripts/`.

## M2 workflow verification

Measured on 2026-11-12 against separate fresh source snapshots, without `.env`.
The local snapshot installed dependencies with `npm ci`; the Docker snapshot had
no host `node_modules` or `dist` before or after either startup. Each workflow
used a separately named temporary Compose project and fresh volume, with explicit
run-ID ownership labels and unused loopback-published ports. The unchanged local
setup/dev commands ran in a Linux network namespace, with a `socat` Unix-socket
bridge to that project's PostgreSQL port, avoiding the running developer stack's
ports. No application source or configuration defaults were changed for the check.

- **Local:** `npm ci` → `npm run setup` → `npm run dev` succeeded. Setup started
  only PostgreSQL and applied both committed migrations through the shared
  initializer. Fresh storage contained 300 brands, 20,000 ads, 12,000 active ads,
  8,000 null ranks and one hashed API key. Through Vite, the documented development
  key returned HTTP 200 with 20 ads and total 20,000; an invalid key returned the
  exact generic HTTP 400 error. Login and authenticated identity returned 200;
  unauthenticated identity returned 401.
- **Docker-only startup:** `docker compose up --build -d` built API/setup and
  compiled web assets from the clean snapshot, then brought up PostgreSQL, the
  one-shot initializer, API and built Nginx web in dependency order. The same fresh
  counts, v0 success/rejection and login/identity checks passed through Nginx.
  Only db/API/web stayed running; neither ingest nor Studio started automatically.
- **Portal:** isolated headless Chromium profiles exercised each workflow's
  direct `/portal` protection, keyboard login, completed refresh, logout and
  completed logged-out refresh. Both displayed the server-verified `demo` and
  Log out control, with no console warnings/errors or runtime exceptions.
  Screenshots were inspected; no browser E2E tooling was added to the repository.
- **Actual ingest and preservation:** root `npm run ingest`, with an explicit
  test-owned `DATABASE_URL`, inserted 5 ads/deactivated 1 seeded ad in the local
  database, and inserted 4/deactivated 1 in the Docker database. SIGTERM to the
  actual CLI drained shutdown; each root command exited 0 and left zero ingest
  database connections. Ingest was stopped before any repeat initialization.
  Complete ordered row snapshots of `users`, `api_keys`, `brands` and `ads`
  (including timestamp precision) were byte-for-byte equal before/after local
  `npm run setup` plus `npm run db:seed`, and Docker `down` → `up --build -d`
  plus `docker compose run --rm --no-deps setup`. This preserved exact credential
  hashes, key IDs/hashes/owners, unrelated user/key/brand/ad rows, an explicitly
  edited headline, actual ingest inserts and deactivated ads. Login/v0 still
  worked after repeat startup. No random backdating outcome was required or
  inferred; controlled `ingest.test.ts`/`ingest-db.test.ts` tests prove its
  probability thresholds and inclusive 1–90-day bounds.
- **Proxy/log safety:** `docker compose exec -T web nginx -T` confirmed the
  server's `access_log off` / `error_log /dev/null` without location overrides.
  Success/rejection produced 200/400; after `docker compose stop api`, the proxy
  produced 504 rather than SPA HTML. Combined stdout/stderr from API/web/setup
  contained none of the public key, key-hash, rejection/upstream/query sentinels
  or `api_key=`. Local setup/dev/seed/ingest output also contained no key-bearing
  sentinels. The first upstream probe's five-second client timeout was too short;
  a repeat with a 70-second allowance observed Nginx's response, without changing
  application, database or test deadlines. Request diagnostics remain deliberately
  discarded, not recoverable from Nginx logs.
- **Cleanup:** only generated projects' containers, networks and volumes were
  removed, after checking Compose-project and run-ID labels. The existing
  developer stack stayed running and its data was not targeted.

Root regression verification: `npm run build`, `npm run lint`, `npm run check`
and `npm test` passed: 267 API unit, 261 disposable-PostgreSQL and 65 web tests
(593 total), including the unchanged v0 contract. No required #51 check remains
unexecuted; final milestone acceptance/human review is separate (#52).

## M3 workflow verification

Measured on 2026-11-12 for #72, from source snapshots of `b586b07`, with Node
26.13.0/npm 11.20.0, Docker 29.7.2/Compose 5.5.1 and PostgreSQL 17.11. Neither
snapshot contained `.env`; the Docker build context also had no host dependencies
or build output. The developer stack stayed running and was not targeted.

Commands actually executed (not inferred from unit tests):

```sh
npm ci
npm run setup
npm run dev
npm run ingest
# Separate clean source snapshot, then repeat after live ingest:
docker compose -p gethookd-72-docker-qa6gt1 \
  -f compose.yaml -f acceptance.override.yaml up --build -d
# Repeat local setup; Docker down/up retains the same isolated volume.
npm run build
npm run lint
npm run check
npm test
```

**Isolation differences:** local setup used project `gethookd-72-local-qa6gt1`,
`COMPOSE_FILE=compose.yaml:acceptance.override.yaml` and an explicit test-owned
`DATABASE_URL` at loopback port 15472. The temporary override changed only
published ports. `npm run dev` ran in a Node 26.13.0 container sharing that
project's network and installed source snapshot, with `DATABASE_URL` pointing to
`db:5432`; this avoided the occupied host API port without changing application
code. Its API was published at 13172. Vite's root, health proxy and Bearer niche
request returned 200 from inside that namespace (`http://[::1]:5173`); Vite's
loopback listener was not reachable through the container's published port.
The full-Docker project used ports 15473/13073/18073 and **no server environment
overrides** for fresh startup. These are isolated execution checks, not claims
that the occupied default host ports were retested or that a new checkout was
created. Ingest used explicit host URLs for the corresponding isolated database.

- **Fresh/repeated startup:** `npm ci`, local setup/dev, and full-Docker build/up
  succeeded. Each initialized 20,000 ads, 300 brands and the public hashed key.
  Root `npm run ingest` was opt-in. After ingest stopped, repeat local setup and
  Docker `down` → `up --build -d` preserved complete evolved users, key IDs/hashes/
  owners and ad rows, including insertion markers. Checks included a changed demo
  hash, unrelated user and reassigned key owner; initialization did not reset them.
- **M2 upgrades:** the actual `main` baseline (`fa2e9c9`) initializer populated
  separate `m2_upgrade` databases. Before upgrading, a headline/date/status was
  changed, a backdated ad added, and users/key ownership evolved. Current local
  setup and Docker setup both migrated 20,001 existing ads: one non-null backfill
  transaction marker, zero nulls, all prior business fields/users/keys unchanged.
  A subsequent insert received `pg_current_xact_id()` by default. Only this
  additive metadata was excluded when comparing pre-M3 ad rows.
- **Live walks:** on fresh local/Docker databases, actual root ingest overlapped
  unfiltered newest and brand-1 impressions paging. Each walk returned exactly
  the initial 20,000/67 IDs, without duplicates or post-boundary inserts. Local
  ingest inserted 6/deactivated 2; Docker inserted 3/deactivated 6; both exited 0
  on SIGINT. A second local run explicitly held **both** first pages until a tick
  committed before continuing: all 20,006/67 initial IDs were returned exactly
  once, with 9 inserts/7 deactivations observed over 6.7 seconds and shutdown 0.
  Random backdating/races were not inferred: controlled PostgreSQL suites prove
  those guarantees separately. No walk-long idle transaction remained.
- **HTTP/lifecycle:** direct APIs and built Nginx proxy passed Bearer discovery,
  detail, multi-niche/date/keyword search, normalized echoes, brand-required 422,
  canonical-niche suggestions, invalid-key 401, invalid/mismatched-cursor 422 and
  changed-page-size continuation with fixed expiry/no-store. Actual API process
  restarts in both workflows preserved cursors. Recreating Docker API with a
  different public test `CURSOR_SECRET` returned nonretryable `INVALID_CURSOR`
  with recovery guidance; fresh search succeeded. Restore itself was not tested;
  [mandatory restore/replacement rotation](#cursor-secret-operations) still applies.
- **Failure/log safety:** stopping isolated PostgreSQL produced sanitized
  retryable 500 through direct API and built proxy, not 401/empty success; recovery
  worked. Stopping API produced Nginx 502, not SPA HTML. A ten-second client probe
  timed out; a bounded 75-second allowance observed the upstream failure without
  changing server/database deadlines. Effective `nginx -T` retained access-log
  off/error-log discard. Captured API/Vite/Nginx/setup/ingest output contained no
  public key, rejected-key/cursor sentinels or sampled real continuation tokens
  across success, rejection and upstream failure. Nginx diagnostics remain
  deliberately discarded, not recoverable or a v1 JSON envelope on upstream 502.
- **Gates/cleanup:** all four root checks passed: 494 API unit, 437 real-PostgreSQL
  and 65 web tests (996 total), no skips. Focused checks passed 95 cursor tests
  for the ADR and 66 HTTP/PostgreSQL OpenAPI tests for the README examples.
  Only this run's containers/networks/volumes were removed after inspecting
  project labels and the dev-container identity;
  developer services remained running. No application behavior, deadlines,
  assertions, dependencies or user-owned documentation were changed.

No production-scale benchmark, arbitrary mutation/multi-worker guarantee, browser
E2E suite or 30-minute wall-clock expiry wait is claimed. Exact expiry/size,
controlled commit races, live status semantics and OpenAPI agreement are covered
by deterministic suites. Cursor rationale and operational limits are in
[ADR-0002](docs/adr/0002-v1-cursor-visibility.md).

## Remaining work, in priority order

1. **M3 final acceptance (#73):** human review of the implemented v1 contracts,
   OpenAPI and isolated workflow results. `DESIGN.md` and `AI_NOTES.md` remain
   user-owned and were not created or modified. Preserve v0's intentional quirks.
2. **M4 — keys and usage:** managed key lifecycle/scopes/revocation, shared
   60-request/minute limits, exact/idempotent billing and the functional portal.
   Implement/test the [v0 429 exception](docs/adr/0001-v0-rate-limit-exception.md)
   here, not in M3; quota enforcement remains a SHOULD requirement. No current v1
   429 response or production-ready authentication is claimed.
3. **M5 — MCP and evaluation:** REST-backed tools consuming shared controls,
   compact outputs and real-model/client evaluation with the required transcripts.
   Cross-brand impression comparisons remain unsupported by brand-local ranks.
