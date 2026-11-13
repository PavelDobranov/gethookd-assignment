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

## A structuring mistake and the fix (#74)

**What the AI produced.** While building M3, the agent added v1 alongside the
existing v0 by stamping a `v1-` **filename prefix** onto new files
(`ads/v1-router.ts`, `ads/v1-query.ts`, `ads/v1-parameters.ts`,
`ads/v1-resources.ts`, `ads/v1-errors.ts`) and a `V1` tag into **identifiers**
(`createV1Router`, `queryV1Ads`, `parseV1Parameters`, `normalizeV1Parameters`,
`validateV1Parameters`, `mapV1AdSummary`, `getV1Ad`, `sendV1Error`,
`handleV1Errors`). v0's files (`ads/router.ts`, `ads/query.ts`,
`ads/parameters.ts`) stayed unmarked at the feature root. It compiled, passed
every test, and shipped — so nothing automated flagged it.

**How it was caught.** The human maintainer, reviewing the layout, pointed out
that a prefix is not a namespace. Two concrete problems followed from that: every
future version would have to re-stamp the prefix across new files *and* function
names, and v0 was silently privileged as "the real one" by being the only
unmarked version — the opposite of the assignment's never-break-v0 intent, where
no version should be the default-by-omission.

**What was done instead.** Make the *directory* the version boundary: `ads/v0/`
and `ads/v1/`, with the version-independent domain (`model.ts`) and the public
contract (`index.ts`) shared at the feature root. Identifiers became version-free
(both routers export `createRouter`), and disambiguation moved to a single place
— import aliasing at the composition root (`app.ts`:
`createRouter as createV1Router`). Adding a future version is now a new `ads/v2/`
folder that renames nothing in v0 or v1. The change was pure move/rename with no
behavior change, guarded by the already-green v0 contract test, the v1 suites and
the OpenAPI drift test. See `docs/adr/0003-api-version-directory-layout.md`.

**Lesson for next time.** "It compiles and tests pass" does not mean a structure
scales. When introducing a second variant of anything (a version, a tenant, a
backend), prefer a boundary that a third variant can join *additively* over a tag
smeared across filenames and identifiers — and never let the first variant be the
unmarked default.
