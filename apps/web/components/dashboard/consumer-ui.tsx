import type { ReactNode } from "react";

/**
 * Consumer Pack chrome. Token-only, exactly like `ui.tsx` — no raw hex, no gradients, no drop
 * shadows. Two chips carry almost all the meaning on these screens, so both are defined once here
 * rather than re-derived per page.
 *
 * The colour choices follow the house rule that there is no red in the palette: a blocked spend is
 * saved waste and reads neutral, and the one colour reserved for "a human is needed" is `signal`.
 */

const STATE_ACCENT: Record<string, string> = {
  // Terminal success.
  COMPLETED: "var(--color-positive)",
  DELIVERY_VERIFIED: "var(--color-positive)",
  // In flight.
  CREATED: "var(--color-data)",
  DISCOVERING: "var(--color-data)",
  QUOTED: "var(--color-data)",
  POLICY_CHECKING: "var(--color-data)",
  APPROVED: "var(--color-data)",
  AWAITING_FUNDING: "var(--color-data)",
  FUNDED: "var(--color-data)",
  EXECUTION_QUEUED: "var(--color-data)",
  PROVIDER_PAYMENT_PENDING: "var(--color-data)",
  PROVIDER_PAID: "var(--color-data)",
  PROVIDER_ACKNOWLEDGED: "var(--color-data)",
  DELIVERY_PENDING: "var(--color-data)",
  // A human is needed.
  AWAITING_APPROVAL: "var(--color-signal)",
  MANUAL_REVIEW: "var(--color-signal)",
  REFUND_PENDING: "var(--color-signal)",
  // Withheld or ended. Neutral, never alarming — a block is the product working.
  BLOCKED: "var(--color-inverse-muted)",
  FAILED_BEFORE_PAYMENT: "var(--color-inverse-muted)",
  FAILED_AFTER_PAYMENT: "var(--color-inverse-muted)",
  REFUNDED: "var(--color-inverse-muted)",
  EXPIRED: "var(--color-inverse-muted)",
  CANCELLED: "var(--color-inverse-muted)",
};

export function StateChip({ state }: { state: string }) {
  const color = STATE_ACCENT[state] ?? "var(--color-inverse-muted)";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-tags px-3 py-1 text-caption-lg"
      style={{ border: `1px solid ${color}`, color, whiteSpace: "nowrap" }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {state.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

const MATURITY_ACCENT: Record<string, string> = {
  verified: "var(--color-positive)",
  sandbox: "var(--color-data)",
  experimental: "var(--color-signal)",
  disabled: "var(--color-inverse-muted)",
};

/**
 * The maturity chip is the honesty surface. It is deliberately prominent everywhere a provider
 * appears, because "this integration has never settled a real payment" is the single most important
 * thing an operator can know about it.
 */
export function MaturityChip({ maturity }: { maturity: string }) {
  const color = MATURITY_ACCENT[maturity] ?? "var(--color-inverse-muted)";
  return (
    <span
      className="inline-flex items-center rounded-tags px-3 py-1 text-caption-lg"
      style={{ border: `1px solid ${color}`, color, letterSpacing: "0.24px", whiteSpace: "nowrap" }}
      title={
        maturity === "verified"
          ? "A real settled payment from an Untch treasury wallet has been observed, and delivery was verified."
          : maturity === "sandbox"
            ? "Adapter implemented and validated against the live spec. NO settlement has ever been made."
            : maturity === "experimental"
              ? "Reachable, but a required leg is unverified. Cannot execute under any configuration."
              : "Not integrated."
      }
    >
      {maturity}
    </span>
  );
}

/** A labelled key/value row — the workhorse of the intent detail page. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>
        {label}
      </span>
      <span className="text-body-sm" style={{ color: "var(--color-text)", overflowWrap: "anywhere" }}>
        {children}
      </span>
    </div>
  );
}

/**
 * The lifecycle timeline. Renders the DURABLE event sequence, so what an operator sees is exactly
 * what a subscriber to the SSE stream saw — one record, two views.
 */
export function Timeline({
  events,
}: {
  events: readonly { seq: number; name: string; state: string; occurredAt: string }[];
}) {
  if (events.length === 0) {
    return (
      <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
        No events recorded yet.
      </span>
    );
  }
  return (
    <ol className="flex flex-col gap-0">
      {events.map((e, i) => (
        <li key={e.seq} className="flex gap-4">
          <div className="flex flex-col items-center">
            <span
              className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: STATE_ACCENT[e.state] ?? "var(--color-inverse-muted)" }}
            />
            {i < events.length - 1 ? (
              <span className="w-px flex-1" style={{ background: "var(--color-border)" }} />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 pb-5">
            <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
              {e.name}
            </span>
            <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
              {e.state} · {new Date(e.occurredAt).toISOString().replace("T", " ").slice(0, 19)}Z
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The two-column evidence panel. `providerAttested` and `untchVerified` are shown SIDE BY SIDE and
 * never merged, because collapsing them would make "verified" mean "the merchant said so" — which is
 * exactly the claim the Proof Engine exists to avoid making.
 */
export function EvidenceSplit({
  attested,
  verified,
}: {
  attested: { status: string; reference: string; attestedAt: string } | null;
  verified: { verified: boolean; method: string; detail: string; verifiedAt: string | null } | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div
        className="rounded-inputs p-4"
        style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border)" }}
      >
        <div className="flex flex-col gap-2">
          <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>
            Provider attested
          </span>
          {attested === null ? (
            <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              Nothing attested yet.
            </span>
          ) : (
            <>
              <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
                {attested.status}
              </span>
              <span className="text-caption" style={{ color: "var(--color-inverse-muted)", overflowWrap: "anywhere" }}>
                ref {attested.reference}
              </span>
            </>
          )}
          <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            This is the merchant&apos;s claim.
          </span>
        </div>
      </div>

      <div
        className="rounded-inputs p-4"
        style={{
          background: "var(--color-canvas)",
          border: `1px solid ${verified?.verified ? "var(--color-positive)" : "var(--color-border)"}`,
        }}
      >
        <div className="flex flex-col gap-2">
          <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>
            Untch verified
          </span>
          <span
            className="text-body-sm"
            style={{ color: verified?.verified ? "var(--color-positive)" : "var(--color-inverse-canvas)" }}
          >
            {verified?.verified ? "Independently confirmed" : "Not independently confirmed"}
          </span>
          <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            {verified?.method ?? "NONE"}
            {verified?.detail ? ` — ${verified.detail}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
