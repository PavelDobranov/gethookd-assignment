import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "div";
  children?: ReactNode;
}

// Bordered surface primitive. Rendered as a <section> by default so callers
// can label it with aria-labelledby; pass `as="div"` for non-landmark cards.
export function Card({ as = "section", className, children, ...rest }: CardProps) {
  const Element = as;
  return (
    <Element className={["card", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Element>
  );
}
