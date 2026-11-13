import { useEffect, useRef } from "react";

import { Button } from "./components/button";
import { EmptyState } from "./components/empty-state";
import { KeyTable } from "./components/key-table";
import { useAppActions, useAppState } from "./state/context";

export function KeysView() {
  const { keys } = useAppState();
  const { openCreate, openRevoke, loadKeys, refreshKeys } = useAppActions();
  const loading = keys.status === "loading" || keys.status === "idle";
  const page = keys.status === "ready" ? keys.page : null;
  const { limit, offset } = keys.pagination;
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterPagination = useRef(false);
  useEffect(() => {
    if (focusAfterPagination.current && !loading && (page || keys.status === "error")) {
      focusAfterPagination.current = false;
      heading.current?.focus();
    }
  }, [loading, page, keys.status]);

  function paginate(nextOffset: number) {
    focusAfterPagination.current = true;
    void loadKeys({ limit, offset: nextOffset });
  }

  return (
    <>
      <header className="view-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            API keys
          </h1>
          <p className="muted">Manage access to the GetHookd API. Keep your secrets safe.</p>
        </div>
        <div className="row">
          <Button variant="outline" disabled={loading || keys.mutating} onClick={() => void refreshKeys()}>
            Refresh keys
          </Button>
          <Button disabled={keys.mutating} onClick={openCreate}>
            Create API key
          </Button>
        </div>
      </header>
      {loading && <p role="status">Loading keys…</p>}
      {keys.status === "error" && (
        <div className="stack">
          <p role="alert" className="alert alert-error">
            {keys.error}
          </p>
          <Button variant="outline" onClick={() => void refreshKeys()}>
            Retry keys
          </Button>
        </div>
      )}
      {page && (
        <div className="table-wrap">
          {page.data.length > 0 ? (
            <KeyTable keys={page.data} mutating={keys.mutating} onRevoke={openRevoke} />
          ) : (
            <EmptyState
              title={offset === 0 ? "No API keys yet" : "No keys on this page"}
              description={
                offset === 0
                  ? "Create your first key to start making API requests."
                  : "Go back to the previous page or refresh the list."
              }
            />
          )}
          <footer className="table-footer">
            <span>
              {page.data.length
                ? `Showing ${page.offset + 1}–${page.offset + page.data.length} keys`
                : "Showing 0 keys"}
            </span>
            <div className="row">
              <Button
                variant="outline"
                size="sm"
                disabled={keys.mutating || offset === 0}
                onClick={() => paginate(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={keys.mutating || !page.has_more}
                onClick={() => paginate(offset + limit)}
              >
                Next
              </Button>
            </div>
          </footer>
        </div>
      )}
      <p className="muted">Only key prefixes are shown here. Secrets are revealed once, when a key is created.</p>
    </>
  );
}
