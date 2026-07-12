import type { ReactNode } from "react";

/**
 * Shared dashboard chrome primitives. Token-only. The design system (colors, type, geometry)
 * extends here directly from @untch/design-tokens — the dashboard reinvents nothing per screen.
 * Cards carry depth from tonal violet fill + hairline borders, never drop shadows (elevation rules).
 */

export function DashCard({ children, className = "", pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <div
      className={`rounded-cards ${pad ? "p-6" : ""} ${className}`}
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ kicker, title, action }: { kicker?: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-2">
        {kicker ? (
          <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
            {kicker}
          </span>
        ) : null}
        <h1 className="text-heading-lg" style={{ color: "var(--color-text)" }}>
          {title}
        </h1>
      </div>
      {action}
    </div>
  );
}

export function StatTile({ label, value, sub, accent = "text" }: { label: string; value: string; sub?: string; accent?: "text" | "data" | "positive" | "signal" | "muted" }) {
  const color = { text: "var(--color-text)", data: "var(--color-data)", positive: "var(--color-positive)", signal: "var(--color-signal)", muted: "var(--color-inverse-muted)" }[accent];
  return (
    <DashCard>
      <div className="flex flex-col gap-2">
        <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>
          {label}
        </span>
        <span className="text-heading-lg" style={{ color }}>
          {value}
        </span>
        {sub ? <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{sub}</span> : null}
      </div>
    </DashCard>
  );
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function Mono({ children, color = "var(--color-inverse-muted)" }: { children: ReactNode; color?: string }) {
  return (
    <span style={{ fontFamily: mono, fontSize: 13, color, overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0, maxWidth: "100%" }}>
      {children}
    </span>
  );
}

export function Meter({ value, max, color = "var(--color-data)" }: { value: number; max: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-tags" style={{ background: "var(--color-canvas)" }}>
      <div className="h-full rounded-tags" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

const CATEGORY_COLOR: Record<string, string> = {
  APPROVED: "var(--color-positive)",
  BLOCKED: "var(--color-inverse-muted)",
  ESCALATED: "var(--color-signal)",
  REJECTED: "var(--color-inverse-muted)",
};

/** Decision chip. No red exists in the palette; blocks are saved waste, so BLOCKED reads neutral. */
export function DecisionChip({ category, label }: { category: string; label: string }) {
  const color = CATEGORY_COLOR[category] ?? "var(--color-inverse-muted)";
  return (
    <span className="inline-flex items-center gap-2 rounded-tags px-3 py-1 text-caption-lg" style={{ border: `1px solid ${color}`, color }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

const BAND_COLOR: Record<string, string> = {
  TRUSTED: "var(--color-positive)",
  STABLE: "var(--color-data)",
  CAUTION: "var(--color-signal)",
  ELEVATED_RISK: "var(--color-inverse-muted)",
  HIGH_RISK: "var(--color-inverse-muted)",
};

export function BandChip({ band }: { band: string }) {
  const color = BAND_COLOR[band] ?? "var(--color-inverse-muted)";
  return (
    <span className="inline-flex items-center rounded-tags px-3 py-1 text-caption-lg" style={{ border: `1px solid ${color}`, color, letterSpacing: "0.24px" }}>
      {band.replace("_", " ")}
    </span>
  );
}

/** A clearly-labeled banner for surfaces backed by a stand-in rather than a live external system. */
export function StandInBanner({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-inputs px-4 py-3 text-body-sm"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-signal)", color: "var(--color-inverse-canvas)" }}
    >
      <span style={{ color: "var(--color-signal)" }}>Stand-in: </span>
      {children}
    </div>
  );
}
