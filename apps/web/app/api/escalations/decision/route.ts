import { NextResponse, type NextRequest } from "next/server";
import { checkSameOrigin } from "../../../../lib/auth/csrf";
import { getServerSession } from "../../../../lib/auth/server";
import { submitDashboardDecision } from "../../../../lib/dashboard/escalation-write";

/**
 * Dashboard-native escalation approve/deny — the fourth control channel's inbound. Authority is the SIWE
 * session (no per-click wallet signature): the signed-in wallet is the sender handle, and the decision runs
 * through the SAME §27 authority-boundary check in @untch/escalation, against the SAME shared Postgres
 * escalation record the other channels resolve. A wallet that doesn't own the escalation's policy fails the
 * §27 check (IGNORED_UNBOUND), never resolves it — the read-scoping is not the only gate.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // State-changing: same-origin only. SameSite=Lax already blocks a cross-site POST; this makes
  // the guarantee explicit so a future cookie change cannot remove it silently.
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return NextResponse.json({ error: origin.reason }, { status: 403 });
  }

  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "sign in to resolve escalations" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { escalationId?: unknown; action?: unknown } | null;
  const escalationId = typeof body?.escalationId === "string" ? body.escalationId : "";
  const action = body?.action === "APPROVE" || body?.action === "DENY" ? body.action : null;
  if (!escalationId || !action) {
    return NextResponse.json({ error: "escalationId and action (APPROVE|DENY) required" }, { status: 400 });
  }

  const result = await submitDashboardDecision({
    operatorWallet: session.address,
    escalationId,
    action,
  });

  // Resolved (APPROVED/DENIED) or a valid intermediate (AWAITING_SECOND_CHANNEL) → 200. An authority
  // failure (IGNORED_UNBOUND — not the owner) → 403. Anything else IGNORED_* → 409 (already resolved /
  // expired / not found): the click did not, and must not, change the record.
  const status =
    result.outcome === "APPROVED" || result.outcome === "DENIED" || result.outcome === "AWAITING_SECOND_CHANNEL"
      ? 200
      : result.outcome === "IGNORED_UNBOUND"
        ? 403
        : 409;
  return NextResponse.json(result, { status });
}
