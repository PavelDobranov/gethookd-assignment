import type { KeyMetadata } from "../portal-api";
import { Badge } from "./badge";
import { Button } from "./button";

// Fixed UTC formatting keeps the rendered dates deterministic across machines.
const dateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

export interface KeyRowProps {
  apiKey: KeyMetadata;
  mutating?: boolean;
  onRevoke: (key: KeyMetadata) => void;
}

export function KeyRow({ apiKey, mutating = false, onRevoke }: KeyRowProps) {
  const revoked = apiKey.revoked_at !== null;
  return (
    <tr>
      <td>
        <span className="badge-mono">{apiKey.prefix}••••</span>
      </td>
      <td>
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
          {apiKey.scopes.map((scope) => (
            <Badge key={scope} mono>
              {scope}
            </Badge>
          ))}
        </span>
      </td>
      <td className="subtle" style={{ whiteSpace: "nowrap" }}>
        {formatDate(apiKey.created_at)}
      </td>
      <td className="subtle" style={{ whiteSpace: "nowrap" }}>
        {apiKey.last_used_at ? formatDate(apiKey.last_used_at) : "Never"}
      </td>
      <td>
        {revoked ? (
          <Badge tone="muted" dot>
            Revoked
          </Badge>
        ) : (
          <Badge tone="success" dot>
            Active
          </Badge>
        )}
      </td>
      <td className="col-actions">
        {revoked ? (
          <Button variant="outline" size="sm" disabled aria-label="Already revoked">
            Revoke
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            busy={mutating}
            aria-label={`Revoke ${apiKey.prefix}`}
            onClick={() => onRevoke(apiKey)}
            style={{ color: "var(--destructive)" }}
          >
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}

export interface KeyTableProps {
  keys: KeyMetadata[];
  mutating?: boolean;
  onRevoke: (key: KeyMetadata) => void;
}

export function KeyTable({ keys, mutating = false, onRevoke }: KeyTableProps) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Scopes</th>
            <th scope="col">Created</th>
            <th scope="col">Last used</th>
            <th scope="col">Status</th>
            <th scope="col" className="col-actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((apiKey) => (
            <KeyRow key={apiKey.id} apiKey={apiKey} mutating={mutating} onRevoke={onRevoke} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
