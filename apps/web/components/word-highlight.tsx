import type { ReactNode } from "react";

/**
 * WordHighlight — design.md "Word Highlight Box": a single headline word wrapped in a
 * 1px dashed Clinical Cyan outline at 7px radius (`rounded-icons`). The signature device.
 *
 * FAITHFUL TO SPEC, including the "one per page maximum" rule — use this on exactly one
 * word per page and nowhere else.
 */
export function WordHighlight({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-icons border border-dashed border-clinical-cyan px-2">
      {children}
    </span>
  );
}
