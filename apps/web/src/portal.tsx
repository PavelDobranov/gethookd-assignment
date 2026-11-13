import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  createKey,
  type KeyList,
  type KeyMetadata,
  type KeyScope,
  listKeys,
  PortalError,
  revokeKey,
} from "./portal-api";
import { Usage } from "./usage";

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
  const [notice, setNotice] = useState("");
  const [mutating, setMutating] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusList = useRef(false);
  const refresh = useCallback(() => {
    focusList.current = true;
    setPagination((value) => ({ ...value }));
  }, []);
  function navigatePage(offset: number) {
    focusList.current = true;
    setPagination({ offset });
  }
  useEffect(() => {
    if (!loading && focusList.current) {
      listHeading.current?.focus();
      focusList.current = false;
    }
  }, [loading]);
  const created = () => {
    setNotice("");
    setPagination({ offset: 0 });
  };
  const revoked = () => {
    setNotice("Revocation confirmed. Refresh the list if updated metadata is unavailable.");
    refresh();
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
      <Usage token={token} onUnauthenticated={onUnauthenticated} />
      <CreateKeyForm
        token={token}
        onCreated={created}
        onUnauthenticated={onUnauthenticated}
        disabled={mutating}
        onPendingChange={setMutating}
      />
      <section aria-labelledby="keys-heading" aria-busy={loading}>
        <div className="section-heading">
          <h2 ref={listHeading} tabIndex={-1} id="keys-heading">
            Your API keys
          </h2>
          <button type="button" onClick={refresh} disabled={loading || mutating}>
            Refresh keys
          </button>
        </div>
        {notice && <p role="status">{notice}</p>}
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
                    {!key.revoked_at && (
                      <RevokeKey
                        keyId={key.id}
                        prefix={key.prefix}
                        token={token}
                        onRevoked={revoked}
                        onUnauthenticated={onUnauthenticated}
                        disabled={mutating}
                        onPendingChange={setMutating}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            <nav className="actions" aria-label="Key list pages">
              <button
                type="button"
                disabled={page.offset === 0 || mutating}
                onClick={() => navigatePage(Math.max(0, page.offset - page.limit))}
              >
                Previous page
              </button>
              <span>Page {Math.floor(page.offset / page.limit) + 1}</span>
              <button
                type="button"
                disabled={!page.has_more || mutating}
                onClick={() => navigatePage(page.offset + page.limit)}
              >
                Next page
              </button>
            </nav>
          </>
        )}
      </section>
    </div>
  );
}

interface MutationProps {
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
}

function RevokeKey({
  keyId,
  prefix,
  token,
  onRevoked,
  onUnauthenticated,
  disabled,
  onPendingChange,
}: Omit<PortalProps, "userId"> &
  MutationProps & {
    keyId: KeyMetadata["id"];
    prefix: string;
    onRevoked: () => void;
  }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lifetime = useRef(0);
  const submitting = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const revokeButton = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(
    () => () => {
      lifetime.current++;
    },
    [],
  );
  useEffect(() => {
    if (confirming) {
      opened.current = true;
      cancelButton.current?.focus();
    } else if (opened.current) revokeButton.current?.focus();
  }, [confirming]);

  async function confirm() {
    if (submitting.current || disabled) return;
    const request = lifetime.current;
    submitting.current = true;
    setPending(true);
    onPendingChange(true);
    setError("");
    try {
      await revokeKey(token, keyId);
      if (request === lifetime.current) onRevoked();
    } catch (failure) {
      if (request !== lifetime.current) return;
      if (failure instanceof PortalError && failure.kind === "unauthenticated") onUnauthenticated();
      else
        setError(
          `Revocation was not confirmed. ${message(failure)} Refresh to check its current state, or retry revocation.`,
        );
    } finally {
      if (request === lifetime.current) {
        submitting.current = false;
        setPending(false);
        onPendingChange(false);
      }
    }
  }
  if (!confirming)
    return (
      <button ref={revokeButton} type="button" disabled={disabled} onClick={() => setConfirming(true)}>
        Revoke {prefix}
      </button>
    );
  return (
    <fieldset disabled={pending || disabled}>
      <legend>Revoke {prefix}?</legend>
      <p>Revocation is permanent. Requests using this key will be rejected; it cannot be reactivated.</p>
      <div className="actions">
        <button type="button" onClick={() => void confirm()}>
          {pending ? "Revoking…" : "Confirm permanent revocation"}
        </button>
        <button
          ref={cancelButton}
          type="button"
          onClick={() => {
            setConfirming(false);
            setError("");
          }}
        >
          Cancel revocation
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}

function CreateKeyForm({
  token,
  onCreated,
  onUnauthenticated,
  disabled,
  onPendingChange,
}: Omit<PortalProps, "userId"> & MutationProps & { onCreated: () => void }) {
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
    if (submitting.current || disabled || scopes.length === 0 || secret) return;
    const request = lifetime.current;
    submitting.current = true;
    setPending(true);
    onPendingChange(true);
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
        onPendingChange(false);
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
        <fieldset disabled={disabled || pending || Boolean(secret)}>
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
        <button
          ref={createButton}
          type="submit"
          disabled={disabled || pending || scopes.length === 0 || Boolean(secret)}
        >
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
