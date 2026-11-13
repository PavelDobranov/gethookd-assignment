import { type ReactNode, useEffect, useRef } from "react";

export interface ModalProps {
  titleId: string;
  describedById?: string;
  role?: "dialog" | "alertdialog";
  onClose: () => void;
  /** Close when the backdrop (not the dialog) is clicked. */
  closeOnBackdrop?: boolean;
  className?: string;
  children: ReactNode;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Accessible dialog: overlays the app, traps Tab within the dialog, closes on
// Escape, and restores focus to the previously focused element on unmount.
// Focus management is a presentational concern, so it lives here, not in state.
export function Modal({
  titleId,
  describedById,
  role = "dialog",
  onClose,
  closeOnBackdrop = true,
  className,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (focusables()[0] ?? dialog)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="overlay">
      {closeOnBackdrop && (
        // A real button, so the backdrop is announced and lint-clean; kept out
        // of the tab order because Escape is the keyboard path to close.
        <button type="button" className="overlay-backdrop" aria-label="Close dialog" tabIndex={-1} onClick={onClose} />
      )}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is always dialog or alertdialog, both of which support aria-modal. */}
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        tabIndex={-1}
        className={["modal", className].filter(Boolean).join(" ")}
      >
        {children}
      </div>
    </div>
  );
}
