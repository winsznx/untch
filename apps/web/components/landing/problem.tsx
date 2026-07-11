/**
 * Problem section — light inversion (design.md "Section Divider (Light Inversion)": hard cut to Pearl,
 * Deep Iris text, no gradient). Two-column explanatory layout: big heading left, body right.
 *
 * NEW DECISION (confirm): copy grounded in PRD §1 thesis + §2 problem statement. No em-dashes, no filler.
 */
export function Problem() {
  return (
    <section className="bg-pearl">
      <div className="mx-auto max-w-page px-6 py-24 lg:py-32">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
          <div className="flex flex-col gap-4">
            <span className="text-caption uppercase" style={{ color: "var(--color-canvas)", letterSpacing: "0.24px", opacity: 0.6 }}>
              The gap
            </span>
            <h2 className="text-heading-lg" style={{ color: "var(--color-canvas)" }}>
              Paying is solved. Paying safely is not.
            </h2>
          </div>
          <div className="flex flex-col gap-6">
            <p className="text-subheading" style={{ color: "var(--color-canvas)" }}>
              OKX solved the first part. An agent can discover services, call paid tools, and settle in
              stablecoins. But once an agent can spend, the operator funding it has no controls: no daily
              budget, no per-call cap, no allowlist, no duplicate protection, no approval threshold.
            </p>
            <p className="text-body" style={{ color: "var(--color-canvas)", opacity: 0.75 }}>
              Hand an agent an unrestricted key and one prompt injection, hallucinated action, or runaway loop
              can drain it. The counterparty is opaque, a star rating with a tiny sample. And nothing checks
              that the delivery matched what was paid for. Untch closes that gap before a payment moves.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
