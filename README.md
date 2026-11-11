# GetHookd

An ad-intelligence platform

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
`{"status":"ok"}`; this is a process-health response, not a PostgreSQL readiness
check. Unknown API routes return Express's HTTP 404 response, not a frontend
SPA page.

```sh
curl -i http://localhost:3000/api/health
```

`apps/api/src/app.ts` exports `createApp()` without opening a listener;
`src/server.ts` owns process startup. Tests use native fetch against a new
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
context. The database client and Drizzle commands use this server-only boundary;
the current health endpoint remains process-only.

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
consumers must select the appropriate context; setup is not yet implemented.

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
npm run test -w @gethookd/api -- tests/db.test.ts  # Isolated migration/read/write tests
```

The workspace scripts invoke the installed Drizzle Kit with
`--config=drizzle.config.ts` from `apps/api`; no tool download is needed.
Start the local database first (`npm run dev:db`) before applying migrations.
Commands use root `.env` / exported configuration as described above. Migration
application is repeatable and preserves records; generation is developer-only,
never performed by startup. Do not use schema push. Review generated SQL and
metadata in `apps/api/drizzle/` and format metadata with Biome before committing.

`src/db/schema.ts` defines UUID primary keys generated by PostgreSQL, unique
non-null usernames and non-null password hashes. `createDatabase(databaseUrl)`
in `src/db/client.ts` returns a Drizzle `db` and async `close()`; callers own the
pool and must close it on shutdown or test teardown. Importing the module does
not connect, migrate or seed. Drizzle query builders / SQL template parameters
keep values separate from SQL. There are no seeded users yet.

The database integration suite applies the real workspace-local migration CLI
against an initially empty disposable PostgreSQL database, checks read/write
behavior, constraints, and repeat application. Only `src/` is compiled into the
API runtime; tests and Drizzle Kit configuration remain outside runtime output.

Drizzle Kit's development-only dependency chain currently reports four moderate
npm audit findings from an older transitive esbuild (GHSA-67mh-4wv8-2f99). The
advisory concerns esbuild's development server, which these generate/migrate
commands do not launch. Do not expose such a server; no forced downgrade or
unreviewed dependency override is applied.

## Password hashing primitive

`apps/api/src/auth/password.ts` provides async `hashPassword` / `verifyPassword`
for future seed/login consumers (not yet wired to accounts). Native Node scrypt
uses a fresh 16-byte salt, a 64-byte key, and the OWASP baseline `N=131072, r=8,
p=1` (~128 MiB per derivation; 256 MiB memory ceiling). The stored format is
`scrypt$N$r$p$saltHex$keyHex`; verification accepts only this bounded cost profile
and uses a timing-safe key comparison. Malformed hashes and wrong passwords
return false. Passwords must contain 1–1024 JavaScript string characters and are
not trimmed or normalized. Neither passwords nor hashes are logged or returned
by HTTP routes. Hashing does not yet create an authentication flow.

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
lint, and `npm run check` runs Biome checks across `apps/`.
