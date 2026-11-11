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
