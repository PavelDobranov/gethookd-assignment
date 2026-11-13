import { Button } from "../../components/button";
import { Card } from "../../components/card";
import { ProgressBar } from "../../components/progress-bar";
import { useAppActions, useAppState } from "../../state/context";
import { CodeBlock } from "./components/code-block";
import { McpConnect } from "./components/mcp-connect";

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86_400)} days ago`;
}

export function OverviewView() {
  const { usage, summary } = useAppState();
  const { openCreate, setView, loadUsage, loadSummary } = useAppActions();
  const data = usage.status === "ready" ? usage.data : null;
  const code = `curl '${window.location.origin}/api/v1/ads?limit=10' \\\n  -H "Authorization: Bearer $GETHOOKD_API_KEY"`;
  return (
    <>
      <header className="view-header">
        <div>
          <h1>Overview</h1>
          <p className="muted">Your GetHookd developer workspace.</p>
        </div>
        <Button onClick={openCreate}>Create API key</Button>
      </header>
      <div className="card-grid">
        <Card className="stack" aria-labelledby="overview-usage-heading">
          <h2 id="overview-usage-heading">Monthly usage</h2>
          {(usage.status === "loading" || usage.status === "idle") && <p role="status">Loading usage…</p>}
          {usage.status === "error" && (
            <>
              <p role="alert">Usage unavailable.</p>
              <Button variant="outline" onClick={() => void loadUsage()}>
                Retry usage
              </Button>
            </>
          )}
          {data && (
            <>
              <p className="quota-number tabular">
                {data.billable_calls.toLocaleString()}{" "}
                <span className="muted">/ {data.quota.toLocaleString()} calls</span>
              </p>
              <ProgressBar value={data.billable_calls} max={data.quota} label="Monthly quota used" />
              <p className="muted">{data.remaining.toLocaleString()} calls remaining</p>
              {data.remaining === 0 && (
                <p className="alert alert-warning">
                  Monthly quota exhausted. New billable calls must wait until reset.
                </p>
              )}
            </>
          )}
          <Button variant="outline" onClick={() => setView("usage")}>
            View usage
          </Button>
        </Card>
        <Card className="stack" aria-labelledby="overview-keys-heading">
          <h2 id="overview-keys-heading">API keys</h2>
          {(summary.status === "loading" || summary.status === "idle") && <p role="status">Loading key summary…</p>}
          {summary.status === "error" && (
            <>
              <p role="alert">Key summary unavailable.</p>
              <Button variant="outline" onClick={() => void loadSummary()}>
                Retry key summary
              </Button>
            </>
          )}
          {summary.status === "ready" && (
            <>
              <dl className="summary-counts">
                <div>
                  <dt>Active</dt>
                  <dd>{summary.active}</dd>
                </div>
                <div>
                  <dt>Revoked</dt>
                  <dd>{summary.revoked}</dd>
                </div>
              </dl>
              <p className="muted">
                Last activity:{" "}
                {summary.lastUsedAt && summary.lastPrefix ? (
                  <>
                    <span className="mono">{summary.lastPrefix}••••</span> ·{" "}
                    <time dateTime={summary.lastUsedAt} title={summary.lastUsedAt}>
                      {relativeTime(summary.lastUsedAt)}
                    </time>
                  </>
                ) : (
                  "No activity yet"
                )}
              </p>
            </>
          )}
          <Button variant="outline" onClick={() => setView("keys")}>
            Manage keys
          </Button>
        </Card>
      </div>
      <Card className="stack" aria-labelledby="getting-started-heading">
        <h2 id="getting-started-heading">Getting started</h2>
        <ol className="stack">
          <li>
            Create a key with the <span className="mono">search:read</span> scope.
          </li>
          <li>
            Store the secret securely as <span className="mono">GETHOOKD_API_KEY</span>.
          </li>
          <li>Make your first request using the example below.</li>
        </ol>
        <CodeBlock title="Your first API request" code={code} />
      </Card>
      <McpConnect />
    </>
  );
}
