import { PillButton } from "./pill-button";
import { WordHighlight } from "./word-highlight";
import { HeroIllustration } from "./hero-illustration";

/**
 * Hero.
 *
 * FAITHFUL TO SPEC (design.md Hero Section + Layout): Deep Iris full-bleed canvas; split layout
 * with the line-art illustration in the left third and the headline + CTA stack in the right
 * two-thirds; headline at display size / weight 600; exactly one word in the WordHighlight box
 * (the one-per-page signature device); sub-copy in Pearl; a ghost pill CTA; a dashboard card
 * overlapping the section's bottom edge.
 *
 * NEW DECISIONS (confirm):
 *  - Headline copy: the PRD's primary tagline "The model never touches the money." (grounded in
 *    the brand section, not invented). WordHighlight on "never" — the operative word.
 *  - Eyebrow: "Accounts payable for autonomous agents" (the PRD one-liner).
 *  - Sub-copy + the two CTAs ("Create a spend policy", "View public receipts") are the PRD's own
 *    website-hero copy verbatim. Destinations /app and /explorer are structural (see README).
 *  - Illustration subject (vault / agent / chain) — see hero-illustration.tsx.
 *  - Mobile: the full line-art is hidden below the lg breakpoint so the headline leads on narrow
 *    screens; the design gives no mobile hero spec.
 *  - Headline sizing steps up 46 → 54 → 92 (display) so the real full-sentence line stays legible
 *    on small screens while hitting the display slot on desktop.
 *  - Overlapping card content uses the §20 demo target read (20.00 budget, 3.20 spent, 1.10
 *    blocked); labeled a representative preview, not live data.
 */
export function Hero() {
  return (
    <section className="relative bg-canvas">
      <div className="mx-auto max-w-page px-6 pt-16 pb-28 lg:pt-24 lg:pb-40">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-3">
          <div className="hidden justify-center lg:flex">
            <HeroIllustration className="max-w-[280px]" />
          </div>

          <div className="flex flex-col gap-8 lg:col-span-2">
            <span
              className="text-caption uppercase"
              style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}
            >
              Accounts payable for autonomous agents
            </span>

            <h1 className="text-heading sm:text-heading-lg lg:text-display" style={{ color: "var(--color-text)" }}>
              The model <WordHighlight>never</WordHighlight> touches the money.
            </h1>

            <p
              className="max-w-2xl text-subheading"
              style={{ color: "var(--color-inverse-canvas)" }}
            >
              Give every agent a budget, a policy, a proof requirement, and a receipt trail. Untch checks every
              payment before it moves and anchors every decision on X Layer.
            </p>

            <div className="flex flex-wrap gap-4">
              <PillButton variant="primary" href="/app">
                Create a spend policy
              </PillButton>
              <PillButton variant="ghost" href="/explorer">
                View public receipts
              </PillButton>
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10 mx-auto -mb-20 max-w-[640px] px-6 lg:-mb-28">
        <HeroPreviewCard />
      </div>
    </section>
  );
}

/** Representative dashboard preview (not live data) — the "blocked waste" screenshot artifact. */
function HeroPreviewCard() {
  return (
    <div
      className="rounded-cards-elevated p-6"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
          Demo policy &middot; agent-01
        </span>
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          representative preview
        </span>
      </div>

      <div className="mt-5 flex items-end gap-3">
        <span className="text-heading-lg" style={{ color: "var(--color-signal)" }}>
          1.10
        </span>
        <span className="mb-2 text-body" style={{ color: "var(--color-inverse-canvas)" }}>
          USDT of waste blocked
        </span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <DecisionChip outcome="APPROVED" label="Approved" />
        <DecisionChip outcome="BLOCKED" label="Blocked as duplicate" />
        <DecisionChip outcome="ESCALATED" label="Escalated 8.00" />
      </div>

      <div
        className="mt-5 flex justify-between border-t pt-4 text-body-sm"
        style={{ borderColor: "var(--color-border-soft)", color: "var(--color-inverse-canvas)" }}
      >
        <span>20.00 budget</span>
        <span>3.20 spent</span>
        <span>1 escalation approved</span>
      </div>
    </div>
  );
}

/**
 * Decision chip color system (NEW DECISION, reused across the dashboard): the palette has no red,
 * and blocks are saved waste rather than errors, so APPROVED reads positive (Mint), ESCALATED reads
 * signal (Teal), and BLOCKED reads neutral-muted (Ash) — never a fabricated error red.
 */
type Outcome = "APPROVED" | "BLOCKED" | "ESCALATED";

const CHIP_COLOR: Record<Outcome, string> = {
  APPROVED: "var(--color-positive)",
  BLOCKED: "var(--color-inverse-muted)",
  ESCALATED: "var(--color-signal)",
};

export function DecisionChip({ outcome, label }: { outcome: Outcome; label: string }) {
  const color = CHIP_COLOR[outcome];
  return (
    <span
      className="inline-flex items-center gap-2 rounded-tags px-3 py-1 text-caption-lg"
      style={{ border: `1px solid ${color}`, color }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
