import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

// Centered placeholder for an empty collection (e.g. no API keys yet).
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <section className="empty-state">
      {icon && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="stack" style={{ gap: 6, maxWidth: 400, alignItems: "center" }}>
        <h2 className="card-title">{title}</h2>
        {description && (
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            {description}
          </p>
        )}
      </div>
      {action}
    </section>
  );
}
