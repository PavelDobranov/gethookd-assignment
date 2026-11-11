# API agent context

Read [API structure](../../docs/agents/file_tree.txt) before changing API structure. Inspect the relevant feature's public exports and existing patterns first.

- Cross-feature imports use `index.ts`; within a feature, import siblings directly.
- Keep business operations independent of Express and HTTP status codes.
- Shared code must be feature-independent and must not depend on business features. Avoid module cycles.
- Only the guide's explicit composition, bootstrap and focused-test exceptions allow internal access. Justify new exceptions.
- Do not scaffold unused files/layers or change API behavior during structural work.

Verify from the repository root:

```sh
npm test             # Includes disposable PostgreSQL integration tests; requires Docker Compose
npm run build        # Includes TypeScript checking
npm run lint
npm run check        # Formatting and import organization too
```

Keep scope and progress in GitHub Issues. Do not duplicate the architecture policy here.
