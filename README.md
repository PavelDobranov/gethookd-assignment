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

Open `http://localhost:5173`; the API is at `http://localhost:3000`. The current
web page is still the scaffold; login/portal work is not implemented yet. A full
built-web Compose stack is also not implemented yet.

`setup` starts **only** Compose `db`, waits up to 30 seconds for healthy TCP
readiness (120-second overall provisioning deadline, including image acquisition),
then runs the shared committed-migration → demo-seed initializer with a 60-second
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
npm run db:seed      # Insert demo only if absent; never reset credentials
npm run db:studio    # Explicit local Studio, 127.0.0.1:4983; stop with Ctrl+C
```

Studio connects to the configured database and prints its browser entry URL.
It is never started by setup, dev, build, tests or default Compose services.
All database commands share the configuration precedence described below.

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
separate database. Drizzle commands use the same server loader in host context. Future setup/container
consumers must select the appropriate context; local setup uses host context.

Compose currently starts **only PostgreSQL 17**, with `POSTGRES_*` defaults or
overrides, a healthcheck using the configured user/database, persistent storage,
and port 5432 bound to `127.0.0.1`. Explicitly empty initialization values fail at
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
skips. Use `npm run test:unit -w @gethookd/api -- tests/password.test.ts` to focus
a unit file without provisioning PostgreSQL.

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
npm run db:seed -w @gethookd/api      # Insert the demo user only if absent
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

### Demo user seeding

After migrations, run `npm run db:seed -w @gethookd/api`. Public local credentials
are username **`demo`**, password **`demo-password`**; only a randomly salted
scrypt hash is stored. Use `POST /api/auth/login` to authenticate. The explicit command uses
the same configuration loader, closes its pool on success or failure, and exits
nonzero with a safe diagnostic if configuration or database access fails. It does
not generate or apply migrations. No passwords, hashes or connection URLs are
printed.

`src/db/seed.ts` exports reusable `seedDemoUser(db)`; imported callers retain
ownership of their database connection. `src/db/initialize.ts` owns one pool and
uses Drizzle's PostgreSQL migrator to apply the same committed SQL/history as
Drizzle Kit, then seeds and closes the pool even on failure. Migration paths are
resolved from the module, independently of the working directory, for source and
compiled execution. Both local setup and the future Compose setup entry point
can use this initializer; API startup never imports or runs it.
Database uniqueness and insert-on-conflict handling leave an existing demo ID and
exact hash untouched. Repeated seeding and setup never reset
a deliberately changed password or changes unrelated users. The documented demo
password therefore stops working if someone deliberately changes it.

```sh
npm run test -w @gethookd/api -- tests/seed.test.ts
```

Tests use a separate database inside the disposable PostgreSQL project, covering
empty/repeated seeding, changed credentials, unrelated records and two real CLI
runs with ID/hash preservation. Unmigrated-database and invalid-configuration
checks require prompt nonzero exits without exposing sensitive details.

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

## Web component tests

```sh
npm run test -w @gethookd/web   # Vitest + jsdom + React Testing Library
```

Component tests render the real app and explicitly clean up the DOM after each
test to prevent cross-test leakage. No browser automation is required.

`npm test` explicitly requires API unit, PostgreSQL integration, and web suites,
stopping with a nonzero exit for a missing workspace/test script, zero collected
tests, a failed prerequisite, or a failing test.
`npm run build` builds and type-checks both workspaces; `npm run lint` runs Biome
lint, and `npm run check` runs Biome checks across `apps/` and `scripts/`.
