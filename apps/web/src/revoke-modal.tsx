import { Badge } from "./components/badge";
import { Button } from "./components/button";
import { Modal } from "./components/modal";
import { useAppActions, useAppState } from "./state/context";

export function RevokeKeyModal() {
  const { ui, keys } = useAppState();
  const { closeModal, revokeKey } = useAppActions();
  const target = ui.revokeTarget;
  if (!target) return null;
  return (
    <Modal role="alertdialog" titleId="revoke-heading" describedById="revoke-warning" onClose={closeModal}>
      <h2 id="revoke-heading" className="modal-title">
        Revoke API key
      </h2>
      <div className="stack">
        <p className="mono">{target.prefix}••••</p>
        <div className="row">
          {target.scopes.map((scope) => (
            <Badge key={scope} mono>
              {scope}
            </Badge>
          ))}
        </div>
        <p className="muted">
          Last used: {target.last_used_at ? <time dateTime={target.last_used_at}>{target.last_used_at}</time> : "Never"}
        </p>
      </div>
      <p id="revoke-warning" className="alert alert-warning">
        Revocation is permanent and cannot be undone. Requests using this key will stop working immediately.
      </p>
      {ui.toast && (
        <p role="alert" className="alert alert-error">
          {ui.toast}
        </p>
      )}
      <div className="modal-actions">
        <Button variant="outline" onClick={closeModal}>
          Cancel
        </Button>
        <Button variant="destructive" busy={keys.mutating} onClick={() => void revokeKey(target.id)}>
          Revoke key
        </Button>
      </div>
    </Modal>
  );
}
