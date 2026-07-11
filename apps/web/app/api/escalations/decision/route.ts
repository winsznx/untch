import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "../../../../lib/auth/server";
import { submitDashboardDecision } from "../../../../lib/dashboard/escalation-runtime";

/**
 * Dashboard-native escalation approve/deny. Authority is the signed-in session: the SIWE-verified wallet
 * is passed as the sender handle, and the real §27 authority-boundary check in @untch/escalation decides
 * the outcome. No fresh signature per click — the session identity is the binding, matching how a bound
 * Telegram handle authorizes an approval.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { escalationId?: string; action?: string } | null;
  if (!body?.escalationId || (body.action !== "APPROVE" && body.action !== "DENY")) {
    return NextResponse.json({ error: "escalationId and action (APPROVE|DENY) required" }, { status: 400 });
  }

  const result = await submitDashboardDecision({
    operatorWallet: session.address,
    escalationId: body.escalationId,
    action: body.action,
  });
  return NextResponse.json(result);
}
