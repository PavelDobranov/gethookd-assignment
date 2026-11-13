import { Button } from "../../components/button";
import { Card } from "../../components/card";
import { ProgressBar } from "../../components/progress-bar";
import { Stat, StatGrid } from "../../components/stat-grid";
import { useAppActions, useAppState } from "../../state/context";

export function UsageView() {
  const { usage } = useAppState();
  const { loadUsage } = useAppActions();
  const loading = usage.status === "loading" || usage.status === "idle";
  const data = usage.status === "ready" ? usage.data : null;
  const resetDays = data ? Math.max(0, Math.ceil((Date.parse(data.period_end) - Date.now()) / 86_400_000)) : 0;

  return (
    <>
      <header className="view-header">
        <div>
          <h1>Usage</h1>
          <p className="muted">Monthly API usage, shared across all your keys.</p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void loadUsage()}>
          {usage.status === "error" ? "Retry usage" : "Refresh usage"}
        </Button>
      </header>
      <Card className="stack" aria-busy={loading} aria-labelledby="monthly-usage-heading">
        <h2 id="monthly-usage-heading">Current monthly usage</h2>
        <p className="muted">Values reflect the last successful server read, not live activity.</p>
        {loading && <p role="status">Loading usage…</p>}
        {usage.status === "error" && (
          <p className="alert alert-error" role="alert">
            Usage unavailable. Retry to read the current period; no usage value is assumed.
          </p>
        )}
        {data && (
          <>
            <p className="quota-number tabular">
              {data.billable_calls.toLocaleString()}{" "}
              <span className="muted">/ {data.quota.toLocaleString()} calls</span>
            </p>
            <ProgressBar value={data.billable_calls} max={data.quota} label="Monthly quota used" />
            <StatGrid>
              <Stat label="Used" value={data.billable_calls.toLocaleString()} />
              <Stat label="Quota" value={data.quota.toLocaleString()} />
              <Stat label="Remaining" value={data.remaining.toLocaleString()} />
              <Stat
                label="Resets"
                value={
                  <time dateTime={data.period_end}>
                    {new Date(data.period_end).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </time>
                }
                note={`${resetDays} days · UTC`}
              />
            </StatGrid>
            <p className="muted">
              Period starts <time dateTime={data.period_start}>{data.period_start}</time>.
            </p>
            {data.remaining === 0 && (
              <p className="alert alert-warning" role="status">
                Monthly quota exhausted. New billable calls must wait until reset. Free key management, usage reads and
                matching previously billed retries remain available under normal authentication, scope and rate limits.
              </p>
            )}
          </>
        )}
      </Card>
      <div className="card-grid">
        <Card>
          <h2>How usage is counted</h2>
          <p className="muted">
            Billable API calls count toward one monthly quota shared across your keys. Creating or revoking keys does
            not consume it.
          </p>
        </Card>
        <Card>
          <h2>Rate limits</h2>
          <p className="muted">
            Rate limits apply independently of monthly quota. If a request is rate-limited, wait before retrying and
            follow the API response guidance.
          </p>
        </Card>
      </div>
    </>
  );
}
