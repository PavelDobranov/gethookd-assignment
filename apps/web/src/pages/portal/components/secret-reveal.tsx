import { useId, useRef, useState } from "react";

import { Button } from "../../../components/button";

export interface SecretRevealProps {
  secret: string;
  label?: string;
}

const RESTING_HINT = "Store it in a password manager or as an environment variable.";
const COPIED_HINT = "Copied to clipboard. Store it in a password manager or as GETHOOKD_API_KEY.";
const FALLBACK_HINT = "Copy unavailable. Select the key and copy it manually.";

// Reveal-once secret field. The only app-adjacent state it holds is the
// ephemeral "copied" flash; the secret itself is owned by the context and
// passed in. On clipboard failure it selects the text for manual copying.
export function SecretReveal({ secret, label = "Secret key" }: SecretRevealProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [copied, setCopied] = useState(false);
  const [hint, setHint] = useState(RESTING_HINT);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setHint(COPIED_HINT);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setHint(FALLBACK_HINT);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }

  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="secret-field" data-copied={copied || undefined}>
        <input
          ref={inputRef}
          id={id}
          className="secret-input"
          readOnly
          value={secret}
          autoComplete="off"
          spellCheck={false}
        />
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? (
            <svg
              width="14"
              height="14"
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
              width="14"
              height="14"
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
        </Button>
      </div>
      <span aria-live="polite" className="stat-note">
        {hint}
      </span>
    </div>
  );
}
