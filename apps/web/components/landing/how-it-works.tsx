import { DecisionChip } from "../hero";

/**
 * How it works — the control loop, as numbered steps (dark canvas). Grounded in the PRD's primary
 * data flow (§6.2) and the invariants. NEW DECISION (confirm): copy + the four-step framing.
 */

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "01",
    title: "Bound the spend",
    body: "The agent creates a canonical SpendIntent with a max amount, a deadline, and committed acceptance criteria. It cannot freestyle a payment because a model said so.",
  },
  {
    n: "02",
    title: "Check before it moves",
    body: "The policy engine evaluates the intent against budgets, caps, allowlists, duplicates, and vendor trust. Approve, block, or escalate. The decision is deterministic, and the model never touches it.",
  },
  {
    n: "03",
    title: "Verify the delivery",
    body: "On delivery the proof engine runs the required tier: schema, signed trace, source hashes. Release is recommended only on a pass, with machine-readable evidence either way.",
  },
  {
    n: "04",
    title: "Receipt on X Layer",
    body: "Every decision and verification is anchored on-chain as a hash. Public proof, private payload. Blocks are receipted too, because a block is auditable value.",
  },
];

export function HowItWorks() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto flex max-w-page flex-col gap-12 px-6 py-24 lg:py-32">
        <div className="flex flex-col gap-4">
          <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
            The loop
          </span>
          <h2 className="max-w-3xl text-heading-lg" style={{ color: "var(--color-text)" }}>
            Bounded intent. Deterministic decision. Verifiable receipt.
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((step) => (
            <div
              key={step.n}
              className="flex flex-col gap-4 rounded-cards p-6"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            >
              <span className="text-heading" style={{ color: "var(--color-border-soft)" }}>{step.n}</span>
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>{step.title}</span>
              <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{step.body}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>Every intent ends in one of:</span>
          <DecisionChip outcome="APPROVED" label="Approved" />
          <DecisionChip outcome="BLOCKED" label="Blocked" />
          <DecisionChip outcome="ESCALATED" label="Escalated" />
        </div>
      </div>
    </section>
  );
}
