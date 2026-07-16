import { DecisionChip } from "../hero";

/**
 * How it works — the control loop as numbered steps with a small visual cue per stage
 * (intent hash → decision → proof → chain). Grounded in PRD §6.2.
 */

const STEPS: {
  n: string;
  title: string;
  body: string;
  cue: string;
  cueLabel: string;
}[] = [
  {
    n: "01",
    title: "Bound the spend",
    body: "The agent creates a canonical SpendIntent with a max amount, a deadline, and committed acceptance criteria. It cannot freestyle a payment because a model said so.",
    cue: "0x4ab1…e992",
    cueLabel: "intentHash",
  },
  {
    n: "02",
    title: "Check before it moves",
    body: "The policy engine evaluates the intent against budgets, caps, allowlists, duplicates, and vendor trust. Approve, block, or escalate. The decision is deterministic, and the model never touches it.",
    cue: "RULE_EVAL",
    cueLabel: "decision",
  },
  {
    n: "03",
    title: "Verify the delivery",
    body: "On delivery the proof engine runs T0 schema verification against committed acceptance criteria. Higher tiers (signed trace, source hashes) are on the roadmap. Release is recommended only on a pass, with machine-readable evidence either way.",
    cue: "T0 · SCHEMA",
    cueLabel: "proof",
  },
  {
    n: "04",
    title: "Receipt on X Layer",
    body: "Every decision and verification is anchored on-chain as a hash. Public proof, private payload. Blocks are receipted too, because a block is auditable value.",
    cue: "ReceiptLogged",
    cueLabel: "anchor",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-canvas scroll-mt-[80px]">
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
              <div className="flex items-start justify-between gap-3">
                <span className="text-heading" style={{ color: "var(--color-border-soft)" }}>
                  {step.n}
                </span>
                <div
                  className="rounded-inputs px-2.5 py-1.5 text-right"
                  style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border-soft)" }}
                >
                  <div className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>
                    {step.cueLabel}
                  </div>
                  <div
                    className="text-caption-lg"
                    style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}
                  >
                    {step.cue}
                  </div>
                </div>
              </div>
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
                {step.title}
              </span>
              <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
                {step.body}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
            Every intent ends in one of:
          </span>
          <DecisionChip outcome="APPROVED" label="Approved" />
          <DecisionChip outcome="BLOCKED" label="Blocked" />
          <DecisionChip outcome="ESCALATED" label="Escalated" />
        </div>
      </div>
    </section>
  );
}
