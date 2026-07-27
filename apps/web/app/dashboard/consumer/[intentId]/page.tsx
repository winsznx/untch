import Link from "next/link";
import { notFound } from "next/navigation";
import { DashCard, MastheadLink, Mono, SectionTitle } from "../../../../components/dashboard/ui";
import { EvidenceSplit, Field, MaturityChip, StateChip, Timeline } from "../../../../components/dashboard/consumer-ui";
import { getScope } from "../../../../lib/dashboard/scope";
import { getPool, policyRepo } from "../../../../lib/dashboard/db";
import { intentDetail, shortAddress, tenantsForPolicies } from "../../../../lib/dashboard/consumer";
import { displayMoney, formatMoney } from "@untch/consumer-core";

export const dynamic = "force-dynamic";

async function ownedTenants(address: string | null): Promise<readonly string[]> {
  if (!address) return [];
  const pool = getPool();
  if (!pool) return [];
  const policies = await policyRepo(pool).listByOwner(address);
  return tenantsForPolicies(policies.map((p) => p.id));
}

export default async function ConsumerIntentDetail({
  params,
}: {
  params: Promise<{ intentId: string }>;
}) {
  const { intentId } = await params;
  const scope = await getScope();
  const tenants = await ownedTenants(scope.address);
  const detail = await intentDetail(tenants, intentId);

  // A tenant-scoped miss is a 404, not an empty page: an operator must not be able to learn that
  // another operator's intent exists by URL.
  if (!detail) notFound();

  const { intent, quote, funding, executions, delivery, ledger, events } = detail;
  const paid = executions.find((e) => e.state === "PAID" || e.state === "ACKNOWLEDGED") ?? null;
  const decision = intent.policyDecision as { decision?: string; reasons?: string[] } | null;

  return (
    <div className="flex flex-col gap-10">
      <SectionTitle
        kicker="Consumer intent"
        title={intent.action}
        subtitle={quote?.summary ?? "One governed consumer action, from proposal to receipt."}
        action={
          <>
            <MastheadLink href="/dashboard/consumer">← Consumer Pack</MastheadLink>
            <StateChip state={intent.state} />
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ── money ─────────────────────────────────────────────────────────── */}
        <DashCard className="lg:col-span-2">
          <div className="flex flex-col gap-6">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Money
            </span>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="User funding">
                {intent.fundingAmount === null ? "—" : displayMoney(intent.fundingAmount)}
              </Field>
              <Field label="Provider settlement">
                {intent.settlementAmount === null ? "—" : displayMoney(intent.settlementAmount)}
              </Field>
              <Field label="Untch fee">{intent.untchFee === null ? "—" : formatMoney(intent.untchFee)}</Field>
              <Field label="Disclosed spread">{intent.spread === null ? "—" : formatMoney(intent.spread)}</Field>
              <Field label="Authorised ceiling">
                {intent.maxAuthorisedAmount === null ? "—" : formatMoney(intent.maxAuthorisedAmount)}
              </Field>
              <Field label="Outstanding obligation">{detail.obligation ?? "—"}</Field>
            </div>

            <div className="grid grid-cols-1 gap-5 border-t pt-5 sm:grid-cols-2" style={{ borderColor: "var(--color-border)" }}>
              <Field label="Funding transaction">
                {funding === null ? "—" : <Mono>{shortAddress(funding.txHash)}</Mono>}
              </Field>
              <Field label="Funding chain">{funding?.chain ?? "—"}</Field>
              <Field label="Settlement transaction">
                {paid?.settlementTxHash ? <Mono>{shortAddress(paid.settlementTxHash)}</Mono> : "—"}
              </Field>
              <Field label="Settlement chain">{paid?.settlementChain ?? "—"}</Field>
              <Field label="Provider recipient">
                {quote ? <Mono>{shortAddress(quote.settlementRecipient)}</Mono> : "—"}
              </Field>
              <Field label="Provider reference">{paid?.providerReference ?? "—"}</Field>
            </div>
          </div>
        </DashCard>

        {/* ── authority ──────────────────────────────────────────────────────── */}
        <DashCard>
          <div className="flex flex-col gap-5">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Authority
            </span>
            <Field label="Policy">
              <Link
                href="/dashboard/policies"
                className="underline-offset-4 hover:underline"
                style={{ color: "var(--color-data)" }}
              >
                #{intent.policyId} v{intent.policyVersion ?? "—"}
              </Link>
            </Field>
            <Field label="Policy hash">
              <Mono>{shortAddress(intent.policyHash)}</Mono>
            </Field>
            <Field label="Engine decision">{decision?.decision ?? "—"}</Field>
            {decision?.reasons && decision.reasons.length > 0 ? (
              <Field label="Reasons">
                <span style={{ color: "var(--color-inverse-canvas)" }}>{decision.reasons.join("; ")}</span>
              </Field>
            ) : null}
            <Field label="Approval">
              {intent.approvalRequired
                ? `${detail.approvalOutcome ?? "PENDING"}${detail.approvalResolvedBy ? ` via ${detail.approvalResolvedBy}` : ""}`
                : "not required by policy"}
            </Field>
            <Field label="Quote hash">
              <Mono>{shortAddress(intent.quoteHash)}</Mono>
            </Field>
            <Field label="SpendIntent hash">
              <Mono>{shortAddress(intent.spendIntentHash)}</Mono>
            </Field>
            <Field label="Receipt">
              {intent.receiptId ? <Mono>{shortAddress(intent.receiptId)}</Mono> : "not anchored"}
            </Field>
          </div>
        </DashCard>
      </div>

      {/* ── delivery ───────────────────────────────────────────────────────── */}
      <DashCard>
        <div className="flex flex-col gap-5">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
            Delivery evidence
          </span>
          <EvidenceSplit
            attested={
              delivery === null
                ? null
                : {
                    status: delivery.providerAttested.status,
                    reference: delivery.providerAttested.reference,
                    attestedAt: delivery.providerAttested.attestedAt,
                  }
            }
            verified={delivery === null ? null : delivery.untchVerified}
          />
        </div>
      </DashCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── timeline ─────────────────────────────────────────────────────── */}
        <DashCard>
          <div className="flex flex-col gap-5">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Timeline
            </span>
            <Timeline events={events} />
          </div>
        </DashCard>

        {/* ── ledger ───────────────────────────────────────────────────────── */}
        <DashCard>
          <div className="flex flex-col gap-5">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Ledger
            </span>
            {ledger.length === 0 ? (
              <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
                No ledger entries yet.
              </span>
            ) : (
              <div className="flex flex-col gap-5">
                {ledger.map((g) => (
                  <div key={g.groupId} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
                        {g.kind}
                      </span>
                      <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                        {g.asset.symbol} · {g.asset.chain}
                      </span>
                    </div>
                    {g.entries.map((e, i) => (
                      <div key={`${g.groupId}-${i}`} className="flex items-baseline justify-between gap-4">
                        <span className="text-caption" style={{ color: "var(--color-inverse-muted)", overflowWrap: "anywhere" }}>
                          {e.accountId.split(":")[0]} — {e.memo}
                        </span>
                        <Mono color={e.amount.amount < 0n ? "var(--color-inverse-muted)" : "var(--color-positive)"}>
                          {formatMoney(e.amount)}
                        </Mono>
                      </div>
                    ))}
                  </div>
                ))}
                <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                  Append-only, double entry. Every group balances to zero within one asset; a cross-rail
                  movement is two groups.
                </span>
              </div>
            )}
          </div>
        </DashCard>
      </div>

      {/* ── attempts ───────────────────────────────────────────────────────── */}
      {executions.length > 0 ? (
        <DashCard>
          <div className="flex flex-col gap-5">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Provider execution attempts
            </span>
            <div className="flex flex-col gap-3">
              {executions.map((e) => (
                <div
                  key={e.executionId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-inputs px-4 py-3"
                  style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border)" }}
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
                      attempt {e.attemptNo} · {e.providerId}
                    </span>
                    <Mono>{e.idempotencyKey}</Mono>
                  </div>
                  <div className="flex items-center gap-3">
                    {e.error ? (
                      <span className="text-caption" style={{ color: "var(--color-signal)" }}>
                        {e.error.code}
                      </span>
                    ) : null}
                    <StateChip state={e.state} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DashCard>
      ) : null}

      {intent.state === "MANUAL_REVIEW" ? (
        <DashCard>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-signal)" }}>
              This intent needs a human
            </span>
            <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              {intent.failureDetail ??
                "The provider's outcome could not be determined. It has NOT been retried — resending a request that may already have purchased something would be a double purchase, not a retry."}
            </p>
            <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              The user&apos;s funding is parked in a SUSPENSE ledger account and is neither spent nor
              refunded until this is resolved. See <Mono>docs/consumer-pack-runbook.md</Mono> →
              &ldquo;Ambiguous purchase or booking&rdquo;.
            </p>
          </div>
        </DashCard>
      ) : null}
    </div>
  );
}
