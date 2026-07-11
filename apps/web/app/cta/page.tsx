import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { PillButton } from "../../components/pill-button";
import { CtaBand } from "../../components/cta-band";

export const metadata: Metadata = {
  title: "Untch CTA variants — review",
  description: "The three pill button components in real page context.",
};

export default function CtaReview() {
  return (
    <>
      <SiteHeader />

      <section className="bg-canvas">
        <div className="mx-auto flex max-w-page flex-col gap-10 px-6 py-24">
          <div className="flex flex-col gap-3">
            <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
              CTA variants
            </span>
            <h1 className="text-heading" style={{ color: "var(--color-text)" }}>
              The three pill buttons
            </h1>
            <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
              design.md specifies three button components. All share the 9999px pill and body-role text.
              Primary carries the ambient glow; ghost sits on the dark canvas; light belongs on violet or
              inverted surfaces.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              On the Deep Iris canvas
            </span>
            <div className="flex flex-wrap gap-5">
              <PillButton variant="primary" href="/app">
                Create a spend policy
              </PillButton>
              <PillButton variant="ghost" href="/explorer">
                View public receipts
              </PillButton>
            </div>
          </div>

          <div
            className="flex flex-col gap-4 rounded-cards p-8"
            style={{ background: "var(--color-surface-raised)" }}
          >
            <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              On a raised violet surface (light variant)
            </span>
            <div className="flex flex-wrap gap-5">
              <PillButton variant="light" href="/app">
                Create a spend policy
              </PillButton>
            </div>
          </div>
        </div>
      </section>

      <CtaBand />
    </>
  );
}
