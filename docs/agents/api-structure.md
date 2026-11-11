# API structure

Use this map to locate behavior and place new code. It is illustrative, not a scaffolding template: create only the files a feature needs.

```text
apps/api/
  src/
    app.ts                    # Compose the application and mount routes
    server.ts                 # Process startup and shutdown
    config.ts                 # Configuration
    db/                       # Database infrastructure and scripts
    <feature>/                # Feature ownership; siblings directly under src/
      index.ts                # Explicit public exports when externally consumed
      routes.ts               # HTTP wiring, input parsing and response mapping
      service.ts              # Business operations, when separation is useful
      <descriptive-name>.ts    # Feature concepts or focused capabilities
    shared/                   # Feature-independent code only, when needed
  tests/                      # Focused and integration tests
```

## Placement and imports

- Inspect existing feature patterns and public exports first. Keep small private helpers near callers; extract substantial or reused concepts when that improves reading. No mandatory file list, pass-through layers, or miscellaneous `utils.ts` buckets.
- Other features import supported operations, factories and types through `index.ts`. Use explicit named exports, not `export *`. Within a feature, import sibling files directly.
- Keep SQL and substantial business rules out of `routes.ts`. Business operations accept ordinary inputs, not Express objects, and do not choose HTTP status codes. Distinguish HTTP parsing/error mapping from business validation/failures.
- Default to feature-local ownership. Shared code must not depend on business features; reuse alone does not make code shared. Avoid circular module dependencies.
- Narrow exceptions: `src/app.ts` may import feature `routes.ts` adapters and their configuration types; focused tests may inspect internals; `src/db/seed.ts` may import `hashPassword` from `auth/password.ts` for demo credentials. Justify any new exception explicitly.

## Application boundary

Web and MCP are separate applications calling the API over HTTP. Keep access policies in the API; do not add in-process MCP adapters or hypothetical transport abstractions. Portal identity and customer API-key access are distinct responsibilities.

Preserve existing API contracts, including v0 parsing, status, error and response quirks. Do not add future feature scaffolding or change policies during structural work. Scope and progress belong in GitHub Issues; see [#28](https://github.com/PavelDobranov/gethookd-assignment/issues/28).
