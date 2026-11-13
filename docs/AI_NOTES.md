# AI notes

**How I worked.** For each milestone I ran a design session to decide
scope one question at a time, turned it into a specification and task list, published those as GitHub
issues, and then implemented each task in its own separate session. Agent instructions are committed:
`AGENTS.md` (symlinked as `CLAUDE.md`) and the skill set in `.agents/skills` (pinned in
`skills-lock.json`). I keep `AGENTS.md` deliberately lean: instead of one long file, it holds
pointers to focused docs (for example `docs/agents/issue-tracker.md` and
`docs/agents/api-file-structure.md`) that the agent opens only when a task needs them, so context
stays small.

## Time spent and tools, per part

| Milestone | Assignment part | Time | Main tools |
|---|---|---|---|
| M1 — Foundation & protected portal | Baseline for Part 4 (login, portal) | ~2.5 h | PI coding agent |
| M2 — World & v0 | Part 0 |~2.5 h | PI coding agent |
| M3 — Strict v1 search | Part 1 | ~2.5 h | PI coding agent |
| M4 — Keys, usage & portal | Part 3 + Part 4 | ~2.5 h | PI coding agent, Claude Design (portal UI) |
| M5 — MCP & evaluation | Part 2 | ~2 h | PI coding agent, Claude Code (also the MCP eval client) |

## Where the AI got it wrong

1. **M3 — a `v1-` prefix instead of a real version boundary.** It added v1 by stamping a `v1-` prefix
   onto filenames and a `V1` tag into function names, and left v0 unmarked. It compiled and every test
   passed, so nothing automated flagged it. **How I caught it:** reviewing the layout, I saw that a
   prefix is not a namespace — every future version would re-stamp the prefix, and v0 was silently
   treated as "the real one." **What I did instead:** make the *folder* the version boundary
   (`ads/v0/`, `ads/v1/`), keep names version-free, and disambiguate in one place at the composition
   root. Adding a `v2` now renames nothing. Guarded by the green v0 contract test and the OpenAPI
   drift test.

2. **M1 — crypto errors hidden as wrong passwords.** `verifyPassword()` caught every error and
   returned `false`, so an unexpected hashing failure looked like a wrong password. **How I caught
   it:** in review I told it to stop swallowing unexpected hashing errors. **What I did instead:** let
   unexpected `scrypt` failures reach the error handler, kept the real wrong-password and bad-hash
   handling, and added regression tests.

3. **M1 — the app's dependency type declared in the wrong module.** `createApp` took a type defined
   inside the auth module that held both the database and the JWT secret, and other factories named
   their inputs `Options`. It worked, but the application's contract lived inside a feature. **How I
   caught it:** I said this did not feel right, questioned the name, and asked for the same fix across
   all factories. **What I did instead:** it added an app-owned `AppDependencies`, removed the
   re-export, and gave each router its own local dependency type.

## One thing I did not delegate

**The design decisions and the approval gates.** I made the scope and architecture choices myself in
the design sessions, one question at a time, and I approved each specification and plan on GitHub
before any code was written. The agent could propose, but it could not decide scope or declare its
own work finished — every milestone had my approval plus human-review checkpoints. A concrete example
I owned: basic auth only — one seeded user, a JWT with no expiry, logout only in the browser — chosen
to keep the demo simple, and clearly not a production design.
