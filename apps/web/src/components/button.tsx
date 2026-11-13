import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  type?: "button" | "submit" | "reset";
  children?: ReactNode;
}

const sizeClass: Record<ButtonSize, string | null> = {
  sm: "btn-sm",
  md: null,
  lg: "btn-lg",
  icon: "btn-icon",
};

// Stateless button primitive. All behaviour (onClick, disabled) arrives via
// props; `busy` dims the control and marks it aria-busy without disabling it.
export function Button({
  variant = "primary",
  size = "md",
  busy = false,
  type = "button",
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, sizeClass[size], className].filter(Boolean).join(" ");
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}
