/**
 * Enforcement modes — four cards (dark canvas). This is Untch's biggest differentiator over a
 * single-mechanism vault, and it was missing from the landing. Grounded verbatim in PRD §14.
 * NEW DECISION (confirm): the card framing + one-line copy.
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
    body: "The broker-side policy gate for APP flows. Holds challenge state, verifies credentials against the original request, and forwards only after a policy pass.",
    strength: "Infrastructure-native",
  },
];

export function Modes() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto flex max-w-page flex-col gap-12 px-6 py-24 lg:py-32">
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

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {MODES.map((m) => (
            <div
              key={m.letter}
              className="flex flex-col gap-4 rounded-cards p-6"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            >
              <span
                className="inline-flex h-10 w-10 items-center justify-center rounded-icons text-title-sm"
                style={{ background: "var(--color-action)", color: "var(--color-text)" }}
              >
                {m.letter}
              </span>
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>{m.name}</span>
              <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{m.body}</span>
              <span className="mt-auto text-caption-lg" style={{ color: "var(--color-data)" }}>{m.strength}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
