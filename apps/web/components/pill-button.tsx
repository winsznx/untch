import Link from "next/link";
import type { ReactNode } from "react";

/**
 * PillButton — the three real button components from design.md, one primitive:
 *   - primary  "Pill CTA Button (Primary)": Iris Pulse fill, Cloud White text, cta-glow.
 *   - ghost    "Pill Button (Ghost)": transparent, Cloud White text + 1px border.
 *   - light    "Pill Button (Light Section)": Pearl fill, Deep Iris text (inverted sections).
 *
 * FAITHFUL TO SPEC: 9999px pill (`rounded-buttons`), body-role text (17px / 500),
 * 16px 24px padding (`py-4 px-6`), the cta-glow only on primary. Motion matches the header:
 * 150ms, brightness/opacity lift, reduced-motion respected.
 */

type Variant = "primary" | "ghost" | "light";

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "bg-action shadow-cta-glow hover:brightness-110 active:brightness-95 focus-visible:ring-offset-canvas",
  ghost: "border border-cloud-white hover:bg-cloud-white/10 focus-visible:ring-offset-canvas",
  light: "bg-pearl hover:brightness-95 focus-visible:ring-offset-pearl",
};

const VARIANT_TEXT: Record<Variant, string> = {
  primary: "var(--color-text)",
  ghost: "var(--color-text)",
  light: "var(--color-canvas)",
};

const BASE =
  "inline-flex items-center justify-center rounded-buttons px-6 py-4 text-body " +
  "transition duration-150 ease-out motion-reduce:transition-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2";

type PillButtonProps = {
  variant?: Variant;
  href?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  "aria-label"?: string;
  children: ReactNode;
};

export function PillButton({
  variant = "primary",
  href,
  onClick,
  type = "button",
  className = "",
  children,
  ...rest
}: PillButtonProps) {
  const cls = `${BASE} ${VARIANT_CLASS[variant]} ${className}`.trim();
  const style = { color: VARIANT_TEXT[variant] };

  if (href) {
    return (
      <Link href={href} className={cls} style={style} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} className={cls} style={style} {...rest}>
      {children}
    </button>
  );
}
