import Link from "next/link";
import { DashCard, MastheadLink, Mono, SectionTitle } from "../../../../components/dashboard/ui";
import { StateChip } from "../../../../components/dashboard/consumer-ui";
import { getScope } from "../../../../lib/dashboard/scope";
import { getPool, policyRepo } from "../../../../lib/dashboard/db";
import { manualReviewQueue, tenantsForPolicies } from "../../../../lib/dashboard/consumer";

export const dynamic = "force-dynamic";

async function ownedTenants(address: string | null): Promise<readonly string[]> {
  if (!address) return [];
  const pool = getPool();
  if (!pool) return [];
  const policies = await policyRepo(pool).listByOwner(address);
  return tenantsForPolicies(policies.map((p) => p.id));
}

export default async function ManualReview() {
  const scope = await getScope();
  const tenants = await ownedTenants(scope.address);
  const queue = await manualReviewQueue(tenants);

  return (
    <div className="flex flex-col gap-10">
      <SectionTitle
        kicker="Consumer Pack"
        title="Manual review"
        subtitle="Intents whose provider outcome could not be determined. None has been retried, and none will be automatically."
        action={<MastheadLink href="/dashboard/consumer">← Consumer Pack</MastheadLink>}
      />

      <DashCard>
        <div className="flex flex-col gap-3">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
            Why an intent lands here
          </span>
          <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
            A request left Untch and its outcome is unknown — a timeout, a dropped connection, or a
            response that could not be parsed. The merchant may have acted. Resending would not be a
            retry; it would be a possible second purchase.
          </p>
          <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
            While an intent waits here, the user&apos;s funding sits in a SUSPENSE ledger account: neither
            spent nor refunded, and fully accounted for. The reconciler queries the provider&apos;s own
            status endpoint on a schedule and clears anything it can answer; what reaches this page is what
            asking did not resolve.
          </p>
        </div>
      </DashCard>

      {queue.length === 0 ? (
        <DashCard>
          <div className="flex flex-col gap-2">
            <span className="text-title-sm" style={{ color: "var(--color-positive)" }}>
              Queue clear
            </span>
            <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              No consumer intent is waiting on a human.
            </p>
          </div>
        </DashCard>
      ) : (
        <div className="flex flex-col gap-3">
          {queue.map((i) => (
            <Link
              key={i.intentId}
              href={`/dashboard/consumer/${i.intentId}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-cards px-5 py-4 transition-opacity hover:opacity-90"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-signal)" }}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
                  {i.action}
                  {i.providerId ? ` · ${i.providerId}` : ""}
                </span>
                <Mono>{i.intentId}</Mono>
                {i.failureCode ? (
                  <span className="text-caption" style={{ color: "var(--color-signal)" }}>
                    {i.failureCode}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                {i.total ? (
                  <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
                    {i.total}
                  </span>
                ) : null}
                <StateChip state={i.state} />
              </div>
            </Link>
          ))}
        </div>
      )}

      <DashCard>
        <div className="flex flex-col gap-3">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
            Resolving one
          </span>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
            <li>Open the intent and read its execution attempts. The provider reference is recorded even when the response was lost.</li>
            <li>Check the merchant&apos;s own order surface for that reference.</li>
            <li>
              If the merchant DID fulfil: the outcome is a completion, and the suspense entry is released
              into fee, spread and cost of goods.
            </li>
            <li>
              If the merchant did NOT: the outcome is a refund, and the suspense entry becomes a refund
              payable.
            </li>
            <li>Either way it is a human decision, recorded as a ledger entry. Nothing here resolves itself.</li>
          </ol>
          <p className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            Full procedure: docs/consumer-pack-runbook.md → &ldquo;Ambiguous purchase or booking&rdquo;.
          </p>
        </div>
      </DashCard>
    </div>
  );
}
