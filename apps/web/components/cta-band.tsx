import { PillButton } from "./pill-button";

/**
 * Closing CTA band, built as a light inversion.
 *
 * FAITHFUL TO SPEC: design.md "Section Divider (Light Inversion)" — a hard color cut from the Deep
 * Iris canvas to a Pearl section with Deep Iris text, no gradient. Centered single-column content
 * (Layout section). The Iris Pulse primary pill pops on Pearl.
 *
 * NEW DECISION (confirm): the copy. "Give your agent a budget and rules in minutes." is grounded in
 * the adoption story (Mode A works in minutes); the CTA is the PRD's canonical primary CTA. /app and
 * /docs are structural destinations.
 */
export function CtaBand() {
  return (
    <section className="bg-pearl">
      <div className="mx-auto flex max-w-page flex-col items-center gap-8 px-6 py-24 text-center lg:py-32">
        <h2 className="max-w-3xl text-heading" style={{ color: "var(--color-canvas)" }}>
          Give your agent a budget and rules in minutes.
        </h2>
        <p className="max-w-xl text-subheading" style={{ color: "var(--color-canvas)" }}>
          Add the policy, connect the agent, and every payment gets checked before it moves and receipted
          on X Layer.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-5">
          <PillButton variant="primary" href="/dashboard">
            Create a spend policy
          </PillButton>
          <a
            href="/docs"
            className="text-body underline-offset-4 transition-opacity duration-150 ease-out hover:opacity-70 hover:underline motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-pearl"
            style={{ color: "var(--color-canvas)" }}
          >
            Read the docs →
          </a>
        </div>
      </div>
    </section>
  );
}
