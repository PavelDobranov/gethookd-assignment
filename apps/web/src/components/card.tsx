import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "div";
  children?: ReactNode;
}

export function Card({ as = "section", className, children, ...rest }: CardProps) {
  const Element = as;

  return (
    <Element className={["card", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Element>
  );
}
