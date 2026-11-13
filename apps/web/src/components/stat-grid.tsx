import type { ReactNode } from "react";

export interface StatProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}

export function Stat({ label, value, note }: StatProps) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note != null && note !== "" && <span className="stat-note">{note}</span>}
    </div>
  );
}

export interface StatGridProps {
  children: ReactNode;
}

export function StatGrid({ children }: StatGridProps) {
  return <div className="stat-grid">{children}</div>;
}
