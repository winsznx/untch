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
 * Visual: phone escalation story (approve / deny coffee intent) + outcome chips — LCP-optimized AVIF
 * from internal/brand, ~24KB at 1440×1080. `priority` + explicit dimensions + sizes for no layout shift.
 * Mobile: content leads, the visual follows below.
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
              <PillButton variant="primary" href="/dashboard">
                Create a spend policy
              </PillButton>
              <PillButton variant="ghost" href="/explorer">
                View public receipts
              </PillButton>
            </div>
          </div>

          <div className="flex justify-center lg:justify-end">
            {/*
              Product art is Deep Iris on Deep Iris — without a frame it dissolves into the canvas.
              Soft Teal ring + lift keeps the phone legible without inventing a second brand color.
            */}
            <div
              className="relative w-full max-w-[420px] lg:max-w-[520px]"
              style={{
                borderRadius: 28,
                boxShadow:
                  "0 0 0 1px color-mix(in srgb, var(--color-signal) 28%, transparent), 0 32px 64px color-mix(in srgb, #000 45%, transparent)",
              }}
            >
              <Image
                src="/untch-hero.avif"
                alt="Untch escalation on a phone: agent wants 4.00 USDT0 for an oat latte above the 3.50 auto limit, with Approve and Deny, and APPROVED, BLOCKED, and ESCALATED outcome chips."
                width={1448}
                height={1086}
                priority
                sizes="(max-width: 1024px) 88vw, 520px"
                className="h-auto w-full rounded-[28px]"
              />
            </div>
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
