# GetHookd

An ad-intelligence platform

## API development and verification

Use Node.js from `.nvmrc` and install workspace dependencies with `npm ci`
from the repository root.

```sh
npm run dev -w @gethookd/api    # API only, with reload on source changes
npm run test -w @gethookd/api   # Vitest HTTP tests; empty/failing suites fail
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
context. Database and authentication consumers are introduced in later tasks;
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
separate database. Future Drizzle/setup/container consumers must use the same
server loader and select the appropriate context; these commands are not yet
implemented.

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

## Web component tests

```sh
npm run test -w @gethookd/web   # Vitest + jsdom + React Testing Library
```

Component tests render the real app and explicitly clean up the DOM after each
test to prevent cross-test leakage. No browser automation is required.

`npm test` explicitly requires both API and web suites, stopping with a nonzero
exit for a missing workspace/test script, zero collected tests, or a failing test.
`npm run build` builds and type-checks both workspaces; `npm run lint` runs Biome
lint, and `npm run check` runs Biome checks across `apps/`.
