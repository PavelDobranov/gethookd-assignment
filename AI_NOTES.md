# AI notes

Running notes on decisions and intentional deferrals, for future sessions.
Specifications, plans and task status live in GitHub Issues (see
`docs/agents/issue-tracker.md`), not here.

## API version-directory layout (#74)

`ads` uses per-version subfolders (`ads/v0/`, `ads/v1/`) with version-free
identifiers; the composition root aliases each `createRouter`. See
`docs/adr/0003-api-version-directory-layout.md` and
`docs/agents/api-file-structure.md`.

Intentional deferrals from that refactor (per spec #54 and the M4/M5 roadmap):

- The **rich v1 error envelope** (`code/message/next_action/retryable/details`,
  in `ads/v1/errors.ts`) stays v1-local. Promote it to `shared/` only once MCP
  (M5) and the M4 `429` give it a second consumer.
- The **API-key Bearer middleware** (currently the inline authenticate handler in
  `ads/v1/router.ts`) stays inline. Extract it into `api-keys/` for v1 + MCP reuse
  once the shared rich envelope exists.
- Do **not** merge the portal-JWT handler (`auth/middleware.ts`) with the API-key
  Bearer handler: spec #54 requires they never cross-authenticate.

The simple `{ error: { code, message } }` envelope is already shared via
`shared/errors.ts` (global error handler, health, portal auth). v0's frozen
`{ error: "Invalid request" }` string is out of scope and must not change.
