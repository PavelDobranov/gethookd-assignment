import { type ReactNode, useRef, useState } from "react";

export interface CodeBlockProps {
  /** The exact text copied to the clipboard. */
  code: string;
  title?: string;
  /** Optional rich rendering of the code; falls back to the raw `code`. */
  children?: ReactNode;
}

// Read-only code sample with a copy button. Holds only the ephemeral "copied"
// flash locally; everything else is presentational.
export function CodeBlock({ code, title, children }: CodeBlockProps) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable; the code remains selectable in the <pre>.
      setCopied(false);
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        {title ? <span className="code-block-title">{title}</span> : <span />}
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => void copy()}
          style={{ color: copied ? "var(--success)" : undefined }}
        >
          {copied ? (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children ?? code}</pre>
    </div>
  );
}
