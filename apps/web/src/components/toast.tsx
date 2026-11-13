import type { ReactNode } from "react";

export type ToastTone = "success" | "error";

export interface ToastProps {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  onDismiss: () => void;
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === "error") {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    );
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

// Transient confirmation. role="status" so it is announced politely; the
// dismiss affordance is a real button.
export function Toast({ title, description, tone = "success", onDismiss }: ToastProps) {
  return (
    <div className="toast" role="status">
      <span className="toast-icon" style={{ color: tone === "error" ? "var(--destructive)" : "var(--success)" }}>
        <ToneIcon tone={tone} />
      </span>
      <div className="toast-body">
        <span className="toast-title">{title}</span>
        {description && <span className="toast-text">{description}</span>}
      </div>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
}
