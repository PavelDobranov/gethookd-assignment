# Developer portal

The desktop React SPA provides Overview, API keys, and Usage views. Sign in with
the account credentials configured on the API (locally, `demo` / `demo-password`).

## Navigation and secrets

Navigation is pure application state, not routing: selecting a sidebar item does
not change the URL or add browser-history entries. Refresh restores the session
and returns to Overview. Browser Back leaves the portal rather than switching tabs.

Create API key opens a modal from either Overview or API keys. Select at least
one scope; there is no key name. The secret is revealed once. Copy it before
closing the modal: acknowledgement, Escape, backdrop dismissal, a view change,
or logout clears it. A late creation response cannot reveal a secret in a closed
or reopened modal. If creation finishes after dismissal, inspect the list and
revoke the key if its secret was not saved.

Revocation requires confirmation and cannot be undone. Creation and revocation
refresh the key list and Overview summary automatically. Summary counts cover
all key-list pages; the table footer describes only the current page.

Usage is shared across all keys. Values are server snapshots, not live counters;
Refresh usage reads them again. A failed refresh shows an error rather than
presenting an older value as current. Monthly quota and rate limiting are separate.

## State ownership

`apps/web/src/state/portal-provider.tsx` owns authentication, backend I/O, request
guards, and reducer dispatch. Connected views consume the split state/actions
contexts. Presentation components receive props and callbacks; selected scopes,
modal state, pending flags, and the revealed secret belong to context.

The running tree is `App` → `PortalProvider` → session view → `PortalShell`.
The shell owns the sidebar, selected view, modals, and toast. API contracts are
unchanged; see [the portal OpenAPI contract](openapi/portal.yaml).
