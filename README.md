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
`Cache-Control: no-store`. Unknown API routes return Express's HTTP 404 response,
not a frontend SPA page.

```sh
curl -i http://localhost:3000/api/health
```

`apps/api/src/app.ts` exports `createApp({ db, jwtSecret })` without opening a
listener or connecting/migrating/seeding the database. `src/server.ts` loads
server-only configuration, owns the database pool and listener, and closes them
on SIGINT/SIGTERM. Tests use native fetch against a new
loopback listener on an ephemeral port per test and close it after each test.
Tests live outside `src/` and are not included in the production build.

## Server configuration

`apps/api/src/config.ts` exports `loadConfig()` for server/database consumers.
It reads the optional repository-root `.env` independently of the working
directory, then applies exported environment variables (including explicit empty
values, which fail validation). It does not mutate `process.env` or expose
configuration to Vite. Missing `.env` is supported; other file-read failures are
reported without revealing contents.

Defaults are `gethookd` for `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_DB`, plus a public development-only JWT signing placeholder of at least
32 bytes. `JWT_SECRET` overrides must be at least 32 UTF-8 bytes. Empty,
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
and `JWT_SECRET` from the exported environment or root `.env`. Absent overrides
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

These credentials and the default signing secret are public development fixtures.
Production requires a private signing secret, non-demo credentials, HTTPS, and an
authentication hardening review. No server settings use the `VITE_` prefix or are
imported by the web app.

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
These fixtures simulate ingest; preservation after actual ingest remains a later
runtime check.

Tests use a separate database inside the disposable PostgreSQL project, covering
empty/repeated seeding, changed credentials/world rows, missing fixtures, occupied
rank repair and two real seed/initializer CLI runs with ID/hash preservation.
Country validation rejects malformed arrays and invalid ISO-2 members. A late
key-insert failure proves full transaction rollback and sanitized nonzero command
exit. Unmigrated-database and invalid-configuration checks also require prompt
nonzero exits without exposing sensitive details. Tests report actual timings for
the 40 batches of 500 ads; two-second query/statement limits stay in force.

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
v0 HTTP authentication and live ingest remain separate pending slices.

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
HTTP authentication is not wired yet.

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
insert its hash if missing; no API-key HTTP endpoint is available. Future managed
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
