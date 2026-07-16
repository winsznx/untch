import { DecisionChip } from "../hero";

/**
 * Operator story — three beats that sell the coffee/mandate loop without a wall of prose.
 * Sits between Problem and How-it-works so the product becomes concrete before the abstract steps.
 */

const BEATS: {
  n: string;
  title: string;
  body: string;
  chip?: { outcome: "APPROVED" | "BLOCKED" | "ESCALATED"; label: string };
}[] = [
  {
    n: "01",
    title: "You set the mandate",
    body: "One coffee. Auto-approve up to 3.50 USDT. Escalate above that. Never twice.",
  },
  {
    n: "02",
    title: "The agent proposes",
    body: "Preferred drip is gone. Oat latte is 4.00. Untch holds the spend and asks you.",
    chip: { outcome: "ESCALATED", label: "Escalated" },
  },
  {
    n: "03",
    title: "You clear once",
    body: "Approve on Telegram or the dashboard. Single-use. Receipt on X Layer. A retry is blocked.",
    chip: { outcome: "APPROVED", label: "Approved once" },
  },
];

export function OperatorStory() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto flex max-w-page flex-col gap-12 px-6 py-24 lg:py-32">
        <div className="flex flex-col gap-4">
          <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
            Operator story
          </span>
          <h2 className="max-w-3xl text-heading-lg" style={{ color: "var(--color-text)" }}>
            Hand an agent ten dollars. Keep the mandate.
          </h2>
          <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
            Balance is not authority. Policy is. When the world drifts from your limit, Untch escalates
            instead of guessing.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {BEATS.map((beat) => (
            <div
              key={beat.n}
              className="flex flex-col gap-4 rounded-cards p-6"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-heading" style={{ color: "var(--color-border-soft)" }}>
                  {beat.n}
                </span>
                {beat.chip ? <DecisionChip outcome={beat.chip.outcome} label={beat.chip.label} /> : null}
              </div>
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
                {beat.title}
              </span>
              <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
                {beat.body}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
            Retry the same buy and:
          </span>
          <DecisionChip outcome="BLOCKED" label="Blocked as duplicate" />
        </div>
      </div>
    </section>
  );
}
