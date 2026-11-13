import type { ReactNode } from "react";

export interface FieldErrorProps {
  id?: string;
  children?: ReactNode;
}

// Inline validation message. Renders nothing when there is no error, so callers
// can mount it unconditionally and wire it with aria-describedby.
export function FieldError({ id, children }: FieldErrorProps) {
  if (!children) {
    return null;
  }

  return (
    <span id={id} role="alert" className="field-error">
      {children}
    </span>
  );
}
