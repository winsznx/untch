import Image from "next/image";
import { PillButton } from "./pill-button";
import { WordHighlight } from "./word-highlight";

/**
 * Hero.
 *
 * FAITHFUL TO SPEC (design.md Hero Section + Layout): Deep Iris full-bleed canvas; split layout with
 * the headline + CTA stack on one side and the product visual on the other; headline at display size /
 * weight 600; exactly one word in the WordHighlight box (the one-per-page signature device); sub-copy
 * in Pearl; a ghost pill CTA.
 *
 * NEW DECISIONS (confirm):
 *  - Headline copy: the PRD's primary tagline "The model never touches the money." WordHighlight on "never".
 *  - Eyebrow + sub-copy + the two CTAs are the PRD's own website-hero copy. Destinations /app and /explorer
 *    are structural (see README).
 *  - Visual: an owner-supplied product-flow illustration (untchflow.avif) showing the real loop — agent,
 *    policy checks, an approval, a blocked duplicate, an escalation. It floats on the Deep Iris canvas as a
 *    product mockup (its background is transparent). This is a deliberate product-shot, distinct from the
 *    "no white cards on the dark canvas" rule which governs design-system cards, not mockups.
 *  - Mobile: content leads, the visual follows below.
 *
 * Image loading (2026 best practices): AVIF (44 KB, from a 2.2 MB PNG); explicit width/height so there is
 * no layout shift; `priority` because it is the above-the-fold LCP visual (eager, high fetch priority,
 * preloaded); `sizes` so smaller viewports fetch a smaller variant; `next/image` generates the responsive
 * srcset and serves the best format per browser.
 */
export function Hero() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto flex min-h-[calc(100dvh-80px)] max-w-page flex-col justify-center px-6 py-16 lg:py-20">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <div className="flex flex-col gap-8">
            <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
              Accounts payable for autonomous agents
            </span>

            <h1 className="text-heading sm:text-heading-lg lg:text-display" style={{ color: "var(--color-text)" }}>
              The model <WordHighlight>never</WordHighlight> touches the money.
            </h1>

            <p className="max-w-2xl text-subheading" style={{ color: "var(--color-inverse-canvas)" }}>
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

          <div className="flex justify-center lg:justify-end">
            <Image
              src="/untchflow.avif"
              alt="Untch decision flow: an agent's payments checked against policy, one approved, a duplicate blocked, and a larger one escalated for approval."
              width={1024}
              height={1536}
              priority
              sizes="(max-width: 1024px) 78vw, 440px"
              className="h-auto w-full max-w-[360px] lg:max-w-[440px]"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Decision chip color system (reused across the landing + dashboard): the palette has no red, and blocks
 * are saved waste rather than errors, so APPROVED reads positive (Mint), ESCALATED reads signal (Teal),
 * and BLOCKED reads neutral-muted (Ash) — never a fabricated error red.
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
