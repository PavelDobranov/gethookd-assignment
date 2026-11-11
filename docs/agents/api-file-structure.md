API structure — illustrative, not mandatory scaffolding. Create only what is needed.

apps/api/
  src/
    app.ts                    # Application composition and route mounting
    server.ts                 # Process startup/shutdown
    config.ts                 # Configuration
    db/                       # Database infrastructure and scripts
    <feature>/                # Feature folders directly under src/
      index.ts                # Public API consumed by other production modules
      routes.ts               # HTTP parsing, wiring and responses
      service.ts              # Business operations, when useful; no Express
      <descriptive-name>.ts    # Feature-specific concepts/capabilities
    shared/                   # Feature-independent code only; no feature imports
  tests/                      # Focused and integration tests

A feature's index.ts exports only values and types needed by production code
outside that feature. Do not re-export internals solely for tests or hypothetical
future consumers. This keeps index.ts an explicit, minimal public contract.
Other features import index.ts; feature internals import siblings directly.
Focused tests may import internal files directly without making those exports
part of the public API. Prefer the public API when testing feature integration.
Keep small helpers local. No empty layers, export *, or circular dependencies.
Exceptions: app.ts may import routes.ts; focused tests may inspect internals;
db/seed.ts may import auth/password.ts for demo credentials.
Web and MCP call the API over HTTP. Preserve existing API behavior.
