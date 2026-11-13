# GetHookd

GetHookd is an ad-intelligence platform. It collects advertiser creatives ("ads")
and exposes them through a REST API for search and discovery, alongside a developer
portal where users sign in, mint scoped API keys, and track their usage against a
monthly quota.

The repository is an npm-workspaces monorepo with two applications — a backend
**API** and a browser **Web** app — backed by **PostgreSQL**.

## Architecture

```
                      ┌─────────────────────────────┐
   Browser  ────────▶ │  Web  (apps/web)            │
                      │  React SPA · Nginx (prod)   │
                      └──────────────┬──────────────┘
                                     │  /api  (reverse proxy)
                                     ▼
   MCP server ─ ─ ─ ─ ─ ─ ─▶ ┌──────────────────────┐
   (planned, M5)   HTTP      │  API  (apps/api)     │
                             │  Express REST        │
                             └──────────┬───────────┘
                                        │  SQL
                                        ▼
                             ┌──────────────────────┐
                             │  PostgreSQL 17       │
                             └──────────────────────┘
```

### Components

- **Web — `apps/web`** (React 19 + Vite, TypeScript). The customer-facing
  single-page app: the login/auth flow and the developer portal for API-key
  management and usage. In production it is a static bundle served by Nginx, which
  also reverse-proxies `/api` to the API. Entry point: `src/main.tsx`.

- **API — `apps/api`** (Express 5, Drizzle ORM, `pg`, `jose`, `zod`). The backend
  REST service. It owns user authentication, the API-key lifecycle, ad search (the
  legacy `v0` contract and the current `v1` contract), usage/billing metering, the
  live-ingest job, and the database schema, migrations, and seed. Entry points:
  `src/server.ts` (HTTP server), `src/app.ts` (app wiring), `src/db/initialize.ts`
  (one-shot migrate + seed), `src/ingest/cli.ts` (ingest).

- **PostgreSQL 17.** The single source of truth: users, API keys, brands, ads, and
  usage/billing records. The API reaches it through Drizzle; schema changes are
  committed SQL migrations under `apps/api/drizzle/`.

- **MCP server — _planned (M5)._** A future Model Context Protocol server that will
  expose the API's search as REST-backed MCP tools. It does not exist yet; when
  built it will call the API over HTTP, just like the Web app.

### How the parts communicate

- **Routes.** The API serves `/api/health`, `/api/auth` and `/api/portal`
  (session-based), `/api/v0` (legacy), and `/api/v1` (current).
- **Ports.** Dev: Web (Vite) on `5173`, API on `3000`, PostgreSQL on `5432`. Prod:
  Web (Nginx) on `8080`, API on `3000`, PostgreSQL on `5432` — all bound to
  loopback only.
- **Proxy.** The browser only talks to the Web origin; `/api` requests are proxied
  to the API (by Vite in dev, by Nginx in prod). Unknown `/api` paths keep the
  API's own 404 rather than falling back to the SPA.
- **Credentials.** Three kinds, all server-side secrets: a user **JWT**
  (`JWT_SECRET`) for the portal/auth routes; stored **Bearer API keys** with scopes
  (`search:read`, `keys:manage`) for `/api/v1`; and a separate **cursor secret**
  (`CURSOR_SECRET`) that signs opaque pagination cursors.

## Prerequisites

- **Node** `26.13.0` (see `.nvmrc`) and **npm**.
- **Docker Engine** and **Docker Compose v2** (supporting `up --wait`).
- Free ports: `5432`, `3000`, and `5173` for local development; `8080` for the full
  Docker stack.
- No `.env` is required — the defaults are public development fixtures.

## Local development

Start Docker Engine / Docker Desktop first, then follow these steps in order.

### 1. Install dependencies

```sh
nvm use          # Node 26.13.0
npm ci
```

### 2. Start and initialize the database

```sh
npm run setup
```

This starts PostgreSQL in Docker on port `5432`, waits until it is healthy, then
applies migrations and seeds the demo data. Leave the database running. You do
not need a separate database-start command when using `setup`.

### 3. Start the API and Web app

```sh
npm run dev      # API on :3000 and the Vite web app on :5173
```

`npm run dev` does **not** start PostgreSQL; complete step 2 first.

Open <http://localhost:5173> and sign in with **`demo`** / **`demo-password`**.
Use the URL printed by Vite if it selects another port, such as `5174`, because
`5173` is already occupied.

If you previously started the full Docker stack, stop its API and Web services
before running the local watchers:

```sh
docker compose stop api web  # leaves PostgreSQL running and preserves data
npm run setup
npm run dev
```

The API needs port `3000`. Vite always proxies `/api` to `http://localhost:3000`,
regardless of which port Vite uses. An old Docker API on `3000` can therefore
receive requests from the new UI and return 404 for routes it does not support.
`npm run setup` does not stop or rebuild existing API/Web containers.

- `npm run setup` starts **only** the Compose `db` service, waits for it to become
  healthy, then runs the shared migrate-and-seed initializer. It never launches the
  API/Web or generates migrations, and it preserves existing data.
- `npm run dev` starts only the API and Web watchers — run `setup` first. Stop with
  `Ctrl+C`; `docker compose stop db` stops PostgreSQL without deleting its volume.
- `npm run ingest` (optional) runs the live-ingest job in a separate terminal to
  evolve the ad data over time.
- `npm run db:studio` (optional) opens Drizzle Studio at `127.0.0.1:4983`.

## Production / full Docker stack

Builds and runs the entire stack in containers; no host Node or `node_modules`
needed.

```sh
docker compose up --build    # db → setup → api → web (Nginx on :8080)
```

Open <http://localhost:8080> and sign in with `demo` / `demo-password`.

Startup is ordered by health: PostgreSQL must be healthy before the one-shot
`setup` service migrates and seeds; `setup` must succeed before the API starts; and
the API must be healthy before the Web server starts. All published ports bind to
loopback only.

```sh
docker compose down          # stop containers; KEEPS the database volume
docker compose up --build    # restart; reapplies pending migrations, preserves data
```

> These are development/demo images, not a hardened production deployment. Replace
> the public default secrets and credentials, and complete a security review,
> before exposing the stack.

## Check the portal

After signing in with `demo` / `demo-password`:

- **Overview** shows usage and API-key summaries.
- **API keys** lets you create scoped keys and permanently revoke them. Copy a
  newly created secret before closing its modal: it is revealed only once.
- **Usage** shows the current monthly quota and offers an explicit refresh.

The sidebar changes views without changing the URL; reloading returns to Overview.
For request details, open browser DevTools → **Network**, filter by `/api`, and
inspect response status/body. Do not share session tokens or revealed API secrets.
Local API/Web logs appear in the terminal running `npm run dev`; Docker logs are
available with `docker compose logs --tail=100 api web`.

### Troubleshooting API 404s

If `/api/portal/usage` or `/api/portal/keys` returns 404, check which API is
running rather than changing the frontend port:

```sh
docker compose ps
curl -i http://localhost:3000/api/health
curl -i http://localhost:3000/api/portal/usage
```

Without an Authorization header, the current portal usage route returns **401**.
A **404** means the service reached does not expose that route; a successful
health check alone does not confirm it is the current API.

- **Local development:** stop the current `npm run dev` with `Ctrl+C`, then use
  `docker compose stop api web`, `npm run setup`, and `npm run dev`. Check startup
  logs for port conflicts and open the URL printed by Vite.
- **Full Docker stack:** stop local API/Web watchers first, then run
  `docker compose up --build` from the current checkout and open
  <http://localhost:8080>. Existing images are not updated by `npm run dev`.

Neither workflow requires deleting the database volume. Avoid
`docker compose down -v` unless you intend to erase the stored data.

## Common commands

| Command | What it does |
| --- | --- |
| `npm test` | API unit + PostgreSQL integration tests, then Web component tests |
| `npm run build` | Type-check and build both workspaces |
| `npm run lint` / `npm run check` | Biome lint / format+lint checks over `apps/` and `scripts/` |
| `npm run db:generate` | Generate a new Drizzle migration (review and commit it) |
| `npm run db:migrate` | Apply committed migrations to the configured database |
| `npm run db:seed` | Seed the demo user, world fixtures, and public API key |
| `npm run ingest` | Run the live ad-ingest job |

Integration tests provision a disposable, isolated PostgreSQL instance via
`compose.test.yaml`; Docker must be running.

## Project structure

```
apps/
  api/            @gethookd/api  — Express REST backend (auth, keys, ads, usage, ingest, DB)
  web/            @gethookd/web  — React SPA (login + developer portal)
    src/pages/login/   Login screen
    src/pages/portal/  Portal views, modals, and portal-specific components
    src/components/    Shared UI primitives
    src/state/         Shared application state and backend I/O provider
    tests/             Web regression and component tests
scripts/
  setup.mjs       Local setup: DB readiness + migrate/seed initializer
docs/             Project documentation (see below)
compose.yaml      Full local/prod stack (db, setup, api, web)
compose.test.yaml Isolated, disposable PostgreSQL for integration tests
AGENTS.md         Contributor & agent conventions (CLAUDE.md is a symlink to it)
.env.example      Optional configuration overrides (public dev defaults)
```

## Configuration

All configuration is optional for local development. To override defaults, copy
`.env.example` to `.env` at the repository root. The settings are:

- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — database credentials.
- `DATABASE_URL` — explicit connection URL; leave unset to derive one from the
  `POSTGRES_*` values (host commands use `localhost:5432`, containers use `db:5432`).
- `JWT_SECRET` — signs user session tokens (≥ 32 bytes).
- `CURSOR_SECRET` — signs search pagination cursors (≥ 32 bytes, independent of
  `JWT_SECRET`).

The shipped defaults are **public development fixtures only** — never use them in
production. See `.env.example` for the full notes, including that `POSTGRES_*` only
provisions a *fresh* database volume.

## Documentation

Project documentation lives under `docs/`:

- **`docs/adr/`** — Architecture Decision Records (ADR-0001 … ADR-0006). The
  reasoning behind significant design choices (e.g. the v1 cursor design, the API
  versioning layout, the usage/accounting model).
- **`docs/agents/`** — engineering and agent conventions:
  - `issue-tracker.md` — GitHub Issues are the source of truth for specs, plans,
    and tasks.
  - `api-file-structure.md` — how API code is organized under `apps/api/src/`.
- **`docs/openapi/`** — the authoritative machine-checked API contracts:
  `v1.yaml` (the v1 REST API) and `portal.yaml` (the JWT-only portal management API).
- **`AGENTS.md`** — top-level contributor/agent conventions (issue tracking, API
  file structure, where documentation and ADRs live).

Specifications, plans, and progress are tracked in **GitHub Issues**, not in-repo
files. The previous, much longer README — which documented the full endpoint
reference and per-milestone verification notes — is archived verbatim at
`docs/archive/README-legacy.md` pending triage into ADRs, OpenAPI, and issues.
