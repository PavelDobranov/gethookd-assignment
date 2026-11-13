import { Button } from "./components/button";
import { LoginScreen } from "./login";
import { PortalShell } from "./shell";
import { useAppActions, useAppState } from "./state/context";
import { PortalProvider } from "./state/portal-provider";
import "./styles.css";

function SessionView() {
  const { session } = useAppState();
  const { restoreSession, signOut } = useAppActions();
  switch (session.status) {
    case "checking":
      return (
        <main className="status-screen">
          <p role="status">Checking session…</p>
        </main>
      );
    case "unavailable":
      return (
        <main className="status-screen">
          <p role="alert">{session.error}</p>
          <div className="row">
            <Button onClick={() => void restoreSession()}>Retry</Button>
            <Button variant="outline" onClick={signOut}>
              Log out
            </Button>
          </div>
        </main>
      );
    case "anonymous":
      return <LoginScreen />;
    case "authenticated":
      return <PortalShell />;
  }
}

export default function App() {
  return (
    <PortalProvider>
      <SessionView />
    </PortalProvider>
  );
}
