API structure — illustrative, not mandatory scaffolding. Create only what is needed.

Optimize for the human maintainer's ability to understand and modify code—not
minimum line count, file count, or additional architectural layers.
Prefer direct Drizzle access in business operations. Introduce additional
persistence abstractions only for a concrete need, not architectural symmetry.

Keep route registration together at the bottom, using named handlers. Prefer
handlers outside the router factory; dependency-bound handlers may use small
factories.

apps/api/
  src/
    app.ts                    # Application composition and route mounting
    server.ts                 # Process startup/shutdown
    config.ts                 # Configuration
    db/                       # Database infrastructure and scripts
    <feature>/                # Feature folders directly under src/
      index.ts                # Public API consumed by other production modules
      router.ts               # HTTP parsing, wiring and responses
      service.ts              # Business operations, when useful; no Express
      <descriptive-name>.ts    # Feature-specific concepts/capabilities
    shared/                   # Feature-independent code only; no feature imports
  tests/                      # Focused and integration tests

API versions live in per-version subfolders `<feature>/v{n}/` (e.g. `ads/v0/`,
`ads/v1/`). Identifiers inside them are version-free — each version's router
exports `createRouter` — and the composition root (`app.ts`) disambiguates once
via import aliasing (`createRouter as createV1Router`). Version-independent
domain and the feature's public `index.ts` stay at the feature root, shared
across versions. A new version is a new `v{n}/` folder that renames nothing in
the existing ones. See `docs/adr/0003-api-version-directory-layout.md`.

A feature's index.ts exports only values and types needed by production code
outside that feature. Do not re-export internals solely for tests or hypothetical
future consumers. This keeps index.ts an explicit, minimal public contract.
Other features import index.ts; feature internals import siblings directly.
Focused tests may import internal files directly without making those exports
part of the public API. Prefer the public API when testing feature integration.
Keep small helpers local. No empty layers, export *, or circular dependencies.
Exceptions: app.ts may import router.ts; focused tests may inspect internals;
db/seed.ts may import auth/password.ts for demo credentials.
Web and MCP call the API over HTTP. Preserve existing API behavior.
