import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { Hero } from "../../components/hero";

export const metadata: Metadata = {
  title: "Untch hero — review",
  description: "Visual review page for the Untch landing hero.",
};

export default function HeroReview() {
  return (
    <>
      <SiteHeader />
      <Hero />

      {/* Following section so the overlapping dashboard card reads against real content below. */}
      <section className="bg-canvas">
        <div className="mx-auto max-w-page px-6 pt-32 pb-24 lg:pt-40">
          <h2 className="text-heading" style={{ color: "var(--color-text)" }}>
            Section below the hero
          </h2>
          <p className="mt-4 max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
            Placeholder content so the dashboard card overlapping the hero&rsquo;s bottom edge is visible in
            context. On the assembled homepage the CTA band and social proof follow here.
          </p>
        </div>
      </section>
    </>
  );
}
