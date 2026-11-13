import { type ReactNode, useRef, useState } from "react";

export interface CodeBlockProps {
  /** The exact text copied to the clipboard. */
  code: string;
  title?: string;
  /** Optional rich rendering of the code; falls back to the raw `code`. */
  children?: ReactNode;
}

type CopyStatus = "idle" | "copied" | "failed";

const STATUS_NOTE: Record<CopyStatus, string> = {
  idle: "",
  copied: "Copied to clipboard.",
  failed: "Copy unavailable. Select the text and copy it manually.",
};

export function CodeBlock({ code, title, children }: CodeBlockProps) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const preRef = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState<CopyStatus>("idle");
  const copied = status === "copied";

  // Fallback when the clipboard is blocked/unavailable: select the rendered
  // code so the reader can copy it manually with the keyboard.
  function selectCode() {
    const pre = preRef.current;
    const selection = window.getSelection();
    if (!pre || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(pre);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("failed");
      selectCode();
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
      <pre ref={preRef}>{children ?? code}</pre>
      <span aria-live="polite" className="stat-note" data-status={status}>
        {STATUS_NOTE[status]}
      </span>
    </div>
  );
}
