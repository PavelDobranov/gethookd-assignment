import { Toast } from "../../components/toast";
import { useAppActions, useAppState } from "../../state/context";
import { Sidebar } from "./components/sidebar";
import { CreateKeyModal } from "./create-modal";
import { KeysView } from "./keys-view";
import { OverviewView } from "./overview";
import { RevokeKeyModal } from "./revoke-modal";
import { UsageView } from "./usage";

const items = [
  { key: "overview", label: "Overview" },
  { key: "keys", label: "API keys" },
  { key: "usage", label: "Usage" },
];

export function PortalShell() {
  const { session, ui } = useAppState();
  const { setView, signOut, dismissToast } = useAppActions();
  return (
    <div className="app-shell">
      <Sidebar
        items={items}
        current={ui.view}
        username={session.user?.username ?? ""}
        onSignOut={signOut}
        onSelect={(view) => {
          if (view === "overview" || view === "keys" || view === "usage") setView(view);
        }}
      />
      <main className="content">
        <div className="content-inner">
          {ui.view === "overview" && <OverviewView />}
          {ui.view === "keys" && <KeysView />}
          {ui.view === "usage" && <UsageView />}
        </div>
      </main>
      {ui.modal === "create" && <CreateKeyModal />}
      {ui.modal === "revoke" && <RevokeKeyModal />}
      {ui.toast && (
        <Toast title={ui.toast} tone={ui.modal === "revoke" ? "error" : "success"} onDismiss={dismissToast} />
      )}
    </div>
  );
}
