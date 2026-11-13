import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { createKey, type KeyList, type KeyScope, listKeys, PortalError } from "./portal-api";

interface PortalProps {
  token: string;
  userId: string;
  onUnauthenticated: () => void;
}

// A new verified identity/credential owns a new lifetime, including all secrets.
export function Portal(props: PortalProps) {
  return <KeyPortal key={`${props.userId}:${props.token}`} {...props} />;
}

function message(failure: unknown) {
  return failure instanceof PortalError ? failure.message : "The portal request failed. Please try again.";
}

function KeyPortal({ token, onUnauthenticated }: PortalProps) {
  const [pagination, setPagination] = useState({ offset: 0 });
  const [page, setPage] = useState<KeyList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    setPagination((value) => ({ ...value }));
  }, []);
  const created = () => {
    setPagination({ offset: 0 });
  };

  useEffect(() => {
    let current = true;
    setLoading(true);
    setPage(null);
    setError("");
    void listKeys(token, pagination).then(
      (result) => {
        if (current) {
          setPage(result);
          setLoading(false);
        }
      },
      (failure: unknown) => {
        if (!current) return;
        if (failure instanceof PortalError && failure.kind === "unauthenticated") onUnauthenticated();
        else {
          setError(message(failure));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [token, pagination, onUnauthenticated]);

  return (
    <div className="portal">
      <CreateKeyForm token={token} onCreated={created} onUnauthenticated={onUnauthenticated} />
      <section aria-labelledby="keys-heading" aria-busy={loading}>
        <div className="section-heading">
          <h2 id="keys-heading">Your API keys</h2>
          <button type="button" onClick={refresh} disabled={loading}>
            Refresh keys
          </button>
        </div>
        {loading && <p role="status">Loading keys…</p>}
        {error && <p role="alert">{error}</p>}
        {page && (
          <>
            {page.data.length === 0 ? (
              <p role="status">No keys on this page.</p>
            ) : (
              <ul className="key-list">
                {page.data.map((key) => (
                  <li key={key.id}>
                    <h3>{key.prefix}</h3>
                    <dl>
                      <dt>Scopes</dt>
                      <dd>{key.scopes.join(", ")}</dd>
                      <dt>Created</dt>
                      <dd>
                        <time dateTime={key.created_at}>{key.created_at}</time>
                      </dd>
                      <dt>Last used</dt>
                      <dd>
                        {key.last_used_at ? <time dateTime={key.last_used_at}>{key.last_used_at}</time> : "Never used"}
                      </dd>
                      <dt>Status</dt>
                      <dd>
                        {key.revoked_at ? (
                          <>
                            Revoked <time dateTime={key.revoked_at}>{key.revoked_at}</time>
                          </>
                        ) : (
                          "Active"
                        )}
                      </dd>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
            <nav className="actions" aria-label="Key list pages">
              <button
                type="button"
                disabled={page.offset === 0}
                onClick={() => setPagination({ offset: Math.max(0, page.offset - page.limit) })}
              >
                Previous page
              </button>
              <span>Page {Math.floor(page.offset / page.limit) + 1}</span>
              <button type="button" disabled={!page.has_more} onClick={() => setPagination({ offset: page.offset + page.limit })}>
                Next page
              </button>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}

function CreateKeyForm({
  token,
  onCreated,
  onUnauthenticated,
}: Omit<PortalProps, "userId"> & { onCreated: () => void }) {
  const [scopes, setScopes] = useState<KeyScope[]>([]);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const lifetime = useRef(0);
  const submitting = useRef(false);
  const reveal = useRef(0);
  const secretInput = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      lifetime.current++;
      reveal.current++;
    },
    [],
  );
  useEffect(() => {
    if (secret) secretInput.current?.focus();
    else if (reveal.current > 0) createButton.current?.focus();
  }, [secret]);

  function toggle(scope: KeyScope) {
    setScopes((selected) => {
      const next = selected.includes(scope) ? selected.filter((value) => value !== scope) : [...selected, scope];
      return (["search:read", "keys:manage"] as const).filter((value) => next.includes(value));
    });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || scopes.length === 0 || secret) return;
    const request = lifetime.current;
    submitting.current = true;
    setPending(true);
    setError("");
    setFeedback("");
    try {
      const result = await createKey(token, scopes);
      if (request !== lifetime.current) return;
      reveal.current++;
      setSecret(result.secret);
      onCreated();
    } catch (failure) {
      if (request !== lifetime.current) return;
      if (failure instanceof PortalError && failure.kind === "unauthenticated") onUnauthenticated();
      else setError(message(failure));
    } finally {
      if (request === lifetime.current) {
        submitting.current = false;
        setPending(false);
      }
    }
  }
  async function copy() {
    const request = reveal.current;
    try {
      await navigator.clipboard.writeText(secret);
      if (request === reveal.current) setFeedback("Secret copied.");
    } catch {
      if (request === reveal.current) {
        setFeedback("Copy unavailable. Select and copy the key manually.");
        secretInput.current?.focus();
        secretInput.current?.select();
      }
    }
  }
  function dismiss() {
    reveal.current++;
    setSecret("");
    setFeedback("");
  }
  return (
    <section aria-labelledby="create-heading">
      <h2 id="create-heading">Create an API key</h2>
      <p>Choose only the permissions this key needs. Scopes cannot be changed later.</p>
      <form onSubmit={submit} aria-busy={pending}>
        <fieldset disabled={pending || Boolean(secret)}>
          <legend>Key scopes (select at least one)</legend>
          <label>
            <input type="checkbox" checked={scopes.includes("search:read")} onChange={() => toggle("search:read")} />{" "}
            search:read
          </label>
          <label>
            <input type="checkbox" checked={scopes.includes("keys:manage")} onChange={() => toggle("keys:manage")} />{" "}
            keys:manage
          </label>
        </fieldset>
        <button ref={createButton} type="submit" disabled={pending || scopes.length === 0 || Boolean(secret)}>
          {pending ? "Creating…" : "Create key"}
        </button>
      </form>
      {pending && <p role="status">Creating key…</p>}
      {error && <p role="alert">{error}</p>}
      {secret && (
        <div className="secret-reveal">
          <p role="status">
            Save this secret now. It cannot be retrieved again. Dismissing, logging out or reloading clears this view.
          </p>
          <label htmlFor="new-secret">New API key</label>
          <input ref={secretInput} id="new-secret" value={secret} readOnly autoComplete="off" spellCheck={false} />
          <div className="actions">
            <button type="button" onClick={() => void copy()}>
              Copy secret
            </button>
            <button type="button" onClick={dismiss}>
              Dismiss secret
            </button>
          </div>
          <p role="status">{feedback}</p>
        </div>
      )}
    </section>
  );
}
