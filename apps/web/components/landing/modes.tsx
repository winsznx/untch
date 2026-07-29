"use client";

import { useEffect, useRef } from "react";

/**
 * Enforcement modes — four cards. Desktop: vertical scroll drives horizontal progress through the
 * ladder (one signature motion). Mobile / reduced-motion: plain vertical grid.
 */

const MODES: { letter: string; name: string; body: string; strength: string }[] = [
  {
    letter: "A",
    name: "Advisory MCP",
    body: "Add the MCP server and a published system-prompt clause. The agent creates an intent and calls preflight before paying.",
    strength: "Any framework, in minutes",
  },
  {
    letter: "B",
    name: "Untch Guard",
    body: "Open-source x402 middleware. On a 402 challenge it runs the binding check and preflight before the agent signs. PII stripped pre-signature.",
    strength: "One import",
  },
  {
    letter: "C",
    name: "Untch Vault",
    body: "Funds live in an on-chain vault. Only oracle-signed approvals within caps move them. Preflight becomes physics, and owner withdraw is unconditional.",
    strength: "One deploy",
  },
  {
    letter: "D",
    name: "Broker Guard",
    body: "Broker-side policy gate for APP flows: hold challenge state, verify credentials against the original request, forward only after a policy pass. Not a live product path yet. A to C are the ladder today.",
    strength: "Roadmap",
  },
];

function ModeCard({ m }: { m: (typeof MODES)[number] }) {
  return (
    <div
      className="flex h-full flex-col gap-4 rounded-cards p-6"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      <span
        className="inline-flex h-10 w-10 items-center justify-center rounded-icons text-title-sm"
        style={{ background: "var(--color-action)", color: "var(--color-text)" }}
      >
        {m.letter}
      </span>
      <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
        {m.name}
      </span>
      <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
        {m.body}
      </span>
      <span className="mt-auto text-caption-lg" style={{ color: "var(--color-data)" }}>
        {m.strength}
      </span>
    </div>
  );
}

export function Modes() {
  const pinRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pin = pinRef.current;
    const track = trackRef.current;
    if (!pin || !track) return;

    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mqDesktop = window.matchMedia("(min-width: 1024px)");

    let raf = 0;

    function measureAndScroll() {
      if (mqReduce.matches || !mqDesktop.matches) {
        track!.style.transform = "";
        return;
      }
      const pinRect = pin!.getBoundingClientRect();
      const pinHeight = pin!.offsetHeight;
      const viewH = window.innerHeight;
      // Progress while the pin section is sticky-ish: from when top hits viewport top to when bottom leaves
      const scrollable = Math.max(1, pinHeight - viewH);
      const traveled = Math.min(scrollable, Math.max(0, -pinRect.top));
      const progress = traveled / scrollable;

      const maxShift = Math.max(0, track!.scrollWidth - track!.parentElement!.clientWidth);
      track!.style.transform = `translate3d(${-maxShift * progress}px, 0, 0)`;
    }

    function onScroll() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measureAndScroll);
    }

    measureAndScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    mqReduce.addEventListener("change", onScroll);
    mqDesktop.addEventListener("change", onScroll);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      mqReduce.removeEventListener("change", onScroll);
      mqDesktop.removeEventListener("change", onScroll);
    };
  }, []);

  return (
    <section id="modes" className="bg-canvas scroll-mt-[80px]">
      {/* Tall pin region on desktop so vertical scroll can scrub the horizontal track */}
      <div ref={pinRef} className="lg:min-h-[180vh]">
        <div className="lg:sticky lg:top-[80px] lg:flex lg:min-h-[calc(100dvh-80px)] lg:flex-col lg:justify-center">
          <div className="mx-auto flex w-full max-w-page flex-col gap-12 px-6 py-24 lg:py-16">
            <div className="flex flex-col gap-4">
              <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
                Four enforcement modes
              </span>
              <h2 className="max-w-3xl text-heading-lg" style={{ color: "var(--color-text)" }}>
                From advice to physics.
              </h2>
              <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
                Adopt in minutes and tighten as the stakes rise. The same policy governs every mode, so the
                control never changes, only how hard it is enforced.
              </p>
            </div>

            {/* Mobile / tablet: normal grid */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:hidden">
              {MODES.map((m) => (
                <ModeCard key={m.letter} m={m} />
              ))}
            </div>

            {/* Desktop: horizontal track scrubbed by vertical scroll */}
            <div className="hidden overflow-hidden lg:block">
              <div
                ref={trackRef}
                className="flex gap-4 will-change-transform"
                style={{ width: "max-content" }}
              >
                {MODES.map((m) => (
                  <div key={m.letter} className="w-[min(340px,28vw)] shrink-0">
                    <ModeCard m={m} />
                  </div>
                ))}
              </div>
              <p className="mt-6 text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                Scroll to move through the ladder →
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
