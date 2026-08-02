import { loadApproval } from "../../../../lib/account/views";
import { Back, Card, KV, NotLinked, Panel, Refusal } from "../../../../components/account/shell";
import { Decide } from "../../../../components/account/decide";

export const dynamic = "force-dynamic";

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const dict = (v: unknown): Dict => (typeof v === "object" && v !== null ? (v as Dict) : {});

export default async function ApprovalDetail({
  params,
}: {
  params: Promise<{ approvalRequestId: string }>;
}) {
  const { approvalRequestId } = await params;
  const view = await loadApproval(approvalRequestId);

  if (!view.authenticated) {
    return (
      <Panel title="Approval">
        <NotLinked />
      </Panel>
    );
  }
  if (view.refusal || !view.detail) {
    return (
      <Panel title="Approval">
        <Back href="/approvals" label="All approvals" />
        <Refusal
          code={view.refusal?.code ?? "APPROVAL_NOT_FOUND"}
          message={
            view.refusal?.message ??
            "No approval request with that id on this account. A request that is not yours answers exactly as one that does not exist."
          }
        />
      </Panel>
    );
  }

  const d = view.detail;
  const quote = dict(d.quote);
  const policy = dict(d.policy);
  const recipient = dict(d.recipient);
  const decisions = Array.isArray(d.decisions) ? (d.decisions as Dict[]) : [];
  const deliveries = Array.isArray(d.deliveries) ? (d.deliveries as Dict[]) : [];
  const actions = dict(d.actions);
  const canDecide = d.state === "PENDING" && quote.expired !== true && typeof d.approvalDigest === "string";

  return (
    <Panel title={`${s(d.amount) ?? "?"} ${s(d.asset) ?? ""}`} sub={s(d.reason) ?? undefined}>
      <Back href="/approvals" label="All approvals" />

      <Card>
        <KV k="State" v={`${s(d.displayLabel) ?? s(d.displayState) ?? s(d.state)}`} />
        <KV k="Provider / capability" v={`${s(d.provider) ?? "?"} / ${s(d.capability) ?? "?"}`} />
        <KV k="Amount" v={`${s(d.amount) ?? "?"} ${s(d.asset) ?? ""}`} />
        <KV k="Quote" v={`${s(quote.quoteId) ?? "—"} · ${s(quote.quoteHash) ?? "—"}`} />
        <KV
          k="Quote expiry"
          v={`${s(quote.expiresAt) ?? "—"}${quote.expired === true ? " — EXPIRED, so this quote can no longer be approved" : ""}`}
        />
        <KV
          k="Recipient"
          v={s(recipient.value) ?? `— (${s(recipient.note) ?? "not resolved"})`}
        />
        <KV k="Policy" v={`${s(policy.policyId) ?? "—"} v${String(policy.version ?? "?")}`} />
        <KV
          k="Rule that escalated"
          v={Array.isArray(policy.triggeringRules) ? (policy.triggeringRules as string[]).join(", ") : "—"}
        />
        <KV k="Intent" v={s(d.intentId) ?? "—"} />
        <KV k="Created" v={s(d.createdAt) ?? "—"} />
        <KV k="Expires" v={s(d.expiresAt) ?? "—"} />
        {s(d.supersededBy) ? <KV k="Superseded by" v={s(d.supersededBy) as string} /> : null}
      </Card>

      {canDecide ? (
        <Decide
          approvalRequestId={approvalRequestId}
          approvalDigest={d.approvalDigest as string}
          amount={s(d.amount)}
          asset={s(d.asset)}
        />
      ) : (
        <Card>
          <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            {/* Why the buttons are absent, rather than showing disabled ones with no explanation. */}
            {d.state !== "PENDING"
              ? `Already ${String(d.state).toLowerCase()}. A resolved approval cannot be decided again, and a second press would be a replay rather than a change of mind.`
              : quote.expired === true
                ? "The quote this approval names has expired. Approving it would authorise a price that is no longer on offer. Ask for a fresh quote."
                : "No decision is available on this request."}
          </span>
        </Card>
      )}

      {actions.approve ? null : null}

      <Panel title="Decisions" sub={decisions.length === 0 ? "Nobody has answered yet." : undefined}>
        {decisions.map((x) => (
          <Card key={String(x.decisionId)}>
            <KV k="Decision" v={`${s(x.decision) ?? "?"} via ${s(x.channel) ?? "?"}`} />
            <KV k="By" v={s(x.actor) ?? "—"} />
            <KV k="At" v={s(x.decidedAt) ?? "—"} />
            {/* The proof that the answer named THIS payment and not whatever was current. */}
            <KV k="Digest matched the request" v={x.digestMatchedRequest === true ? "yes" : "NO"} />
          </Card>
        ))}
      </Panel>

      <Panel
        title="Delivery"
        sub={
          deliveries.length === 0
            ? "No channel delivery was attempted. Nobody was told, which is different from being told and ignoring it."
            : undefined
        }
      >
        {deliveries.map((x, i) => (
          <Card key={`${String(x.channel)}-${i}`}>
            <KV k={s(x.channel) ?? "channel"} v={`${s(x.outcome) ?? "?"} — ${s(x.detail) ?? ""}`} />
            <KV k="Attempted" v={s(x.attemptedAt) ?? "—"} />
          </Card>
        ))}
      </Panel>
    </Panel>
  );
}
