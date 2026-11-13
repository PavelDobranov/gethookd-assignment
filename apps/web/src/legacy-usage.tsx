import { useEffect, useRef, useState } from "react";

import { getUsage, type OwnerUsage, PortalError } from "./portal-api";

export function Usage({ token, onUnauthenticated }: { token: string; onUnauthenticated: () => void }) {
  const [refresh, setRefresh] = useState(0);
  return (
    <UsageRead
      key={`${token}:${refresh}`}
      token={token}
      focusRefresh={refresh > 0}
      onUnauthenticated={onUnauthenticated}
      onRefresh={() => setRefresh((value) => value + 1)}
    />
  );
}

function UsageRead({
  token,
  onUnauthenticated,
  onRefresh,
  focusRefresh,
}: {
  token: string;
  focusRefresh: boolean;
  onUnauthenticated: () => void;
  onRefresh: () => void;
}) {
  const [usage, setUsage] = useState<OwnerUsage["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!loading && focusRefresh) refreshButton.current?.focus();
  }, [loading, focusRefresh]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setUsage(null);
    setError(false);
    void getUsage(token).then(
      (result) => {
        if (!current) return;
        setUsage(result.data);
        setLoading(false);
      },
      (failure: unknown) => {
        if (!current) return;
        if (failure instanceof PortalError && failure.kind === "unauthenticated") onUnauthenticated();
        else {
          setError(true);
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [token, onUnauthenticated]);

  return (
    <section aria-labelledby="usage-heading" aria-busy={loading}>
      <div className="section-heading">
        <h2 id="usage-heading">Current monthly usage</h2>
        <button ref={refreshButton} type="button" disabled={loading} onClick={onRefresh}>
          {error ? "Retry usage" : "Refresh usage"}
        </button>
      </div>
      <p>Shared across all your API keys. Values reflect the last successful server read, not live activity.</p>
      {loading && <p role="status">Loading usage…</p>}
      {error && <p role="alert">Usage unavailable. Retry to read the current period; no usage value is assumed.</p>}
      {usage && (
        <div role="status">
          <dl>
            <dt>Period start (UTC)</dt>
            <dd>
              <time dateTime={usage.period_start}>{usage.period_start}</time>
            </dd>
            <dt>Resets at (UTC)</dt>
            <dd>
              <time dateTime={usage.period_end}>{usage.period_end}</time>
            </dd>
            <dt>Billable calls / quota</dt>
            <dd>
              {usage.billable_calls} / {usage.quota}
            </dd>
            <dt>Remaining calls</dt>
            <dd>{usage.remaining}</dd>
          </dl>
          {usage.remaining === 0 && (
            <p>
              Monthly quota exhausted. New billable calls must wait until reset. Free key management, usage reads and
              matching previously billed retries remain available under normal authentication, scope and rate limits.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
