import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "muted" | "accent";

export interface BadgeProps {
  tone?: BadgeTone;
  /** Render a monospace chip (scopes, key prefixes) instead of a pill. */
  mono?: boolean;
  /** Show a leading status dot (Active / Revoked). */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

// Status pill or monospace chip. Purely presentational.
export function Badge({ tone = "neutral", mono = false, dot = false, className, children }: BadgeProps) {
  if (mono) {
    return <span className={["badge-mono", className].filter(Boolean).join(" ")}>{children}</span>;
  }
  const toneClass = tone === "neutral" ? null : `badge-${tone}`;
  return (
    <span className={["badge", toneClass, className].filter(Boolean).join(" ")}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
