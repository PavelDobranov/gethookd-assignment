# ADR 0001: Feature-first server modules

## Status
Accepted for implementation at maintainer request; source: [issue #28](https://github.com/PavelDobranov/gethookd-assignment/issues/28).

## Context
Optimize for the maintainer finding and understanding behavior, not uniform file lists or fewer files. Web and MCP are separate applications calling the API over HTTP. The API owns API-key access, rate limits and metering, including retries; portal identity is a distinct responsibility.

## Decision
- Feature folders live directly under `apps/api/src/` (for example, `auth/`), without a `modules/` parent. `app.ts` composes HTTP adapters, `server.ts` owns process lifecycle, `config.ts` owns configuration, and `db/` owns database infrastructure/scripts.
- `index.ts` declares supported cross-feature exports when a feature has external consumers. Use explicit named exports of operations, factories and types, not `export *` or forwarding wrappers. Other features use this entry point; internal code imports siblings directly.
- `routes.ts` means HTTP wiring and request/response handling. Keep SQL and substantial business rules out. Small private parsing and HTTP-error helpers may stay beside handlers.
- `service.ts`, when useful, contains business operations independent of Express objects and HTTP status codes. It is not a mandatory forwarding layer.
- Other filenames describe real concepts (`password.ts`, `pricing.ts`, `search-input.ts`). No mandatory file list, empty scaffolding, miscellaneous helper buckets or symmetry-driven renames. Extract queries/helpers when they earn their navigation cost; keep small private helpers local.
- Default to feature ownership. `shared/` is only for feature-independent concepts and must not depend on business features. Reuse alone does not make a capability shared. Avoid circular module dependencies; reconsider ownership or introduce a concrete coordinating operation.

### Narrow exceptions
- Composition in `src/app.ts` may import a feature's `routes.ts` and its adapter configuration types directly.
- Focused tests in `apps/api/tests/` may inspect internals; this does not grant production consumers that access.
- `src/db/seed.ts` may import `hashPassword` from `auth/password.ts` to create demo credentials. This is an intentional bootstrap dependency, not permission for database infrastructure to consume arbitrary auth internals or a reason to publish password helpers.

Inspect relevant public exports and existing feature patterns before changing code. Justify any new exception explicitly. Keep business validation distinct from HTTP syntax validation and business failures distinct from HTTP error mapping, even when no separate file is needed.

## Consequences
Feature layouts may differ. Ordinary functions and existing dependency-supplying factories suffice; no repository interfaces, controller classes, DI framework, generic transport wrappers or package splitting are required. Keep business operations HTTP-independent for clarity and testing, not hypothetical in-process MCP reuse.

Preserve existing behavior, especially v0 parsing, status, error and response quirks; do not silently impose v1's stricter contract. This convention does not introduce new authentication, billing or idempotency policies. Do not create future product modules during structural refactoring.

Objective import boundaries belong in automated checks; cohesion and readability remain review judgments. Implementation scope, plans and progress stay in GitHub Issues, not this decision record.
