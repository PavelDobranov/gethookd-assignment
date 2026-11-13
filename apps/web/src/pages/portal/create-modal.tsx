import { useEffect, useRef } from "react";

import { Button } from "../../components/button";
import { FieldError } from "../../components/field-error";
import { Modal } from "../../components/modal";
import { useAppActions, useAppState } from "../../state/context";
import { SecretReveal } from "./components/secret-reveal";

const scopes = ["search:read", "keys:manage"] as const;

export function CreateKeyModal() {
  const { ui, create } = useAppState();
  const { closeModal, toggleCreateScope, createKey, dismissSecret } = useAppActions();
  const reveal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (create.secret) reveal.current?.querySelector("input")?.focus();
  }, [create.secret]);
  return (
    <Modal titleId="create-heading" describedById="create-description" onClose={closeModal}>
      <div>
        <h2 id="create-heading" className="modal-title">
          {create.secret ? "Save your API key" : "Create an API key"}
        </h2>
        <p id="create-description" className="muted">
          {create.secret
            ? "Copy this secret now. You won't be able to see it again."
            : "Choose the permissions this key needs. Grant only the access required."}
        </p>
      </div>
      {create.secret ? (
        <>
          <p className="mono">Prefix: {create.secret.slice(0, 12)}••••</p>
          <div ref={reveal}>
            <SecretReveal secret={create.secret} label="New API key" />
          </div>
          <div className="modal-actions">
            <Button
              onClick={() => {
                dismissSecret();
                closeModal();
              }}
            >
              I've saved my key
            </Button>
          </div>
        </>
      ) : (
        <form
          className="stack"
          aria-busy={create.pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (!create.pending && ui.createDraft.scopes.length > 0) void createKey();
          }}
        >
          <fieldset className="scope-fields stack" disabled={create.pending} aria-describedby="scope-hint">
            <legend className="label">Scopes</legend>
            {scopes.map((scope) => (
              <label key={scope} className="scope-option" data-selected={ui.createDraft.scopes.includes(scope)}>
                <input
                  type="checkbox"
                  checked={ui.createDraft.scopes.includes(scope)}
                  onChange={() => toggleCreateScope(scope)}
                />
                <span>
                  <span className="mono">{scope}</span>
                  <span className="scope-description muted">
                    {scope === "search:read" ? "Search the GetHookd API." : "Create, list and revoke API keys."}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p id="scope-hint" className="muted">
            Select at least one scope.
          </p>
          {create.error && <FieldError>{create.error}</FieldError>}
          {create.pending && <p role="status">Creating key…</p>}
          <div className="modal-actions">
            <Button variant="outline" onClick={closeModal}>
              Cancel
            </Button>
            <Button type="submit" busy={create.pending} disabled={ui.createDraft.scopes.length === 0}>
              Create key
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
