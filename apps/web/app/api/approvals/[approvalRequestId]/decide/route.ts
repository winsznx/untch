import { NextResponse, type NextRequest } from "next/server";
import { checkSameOrigin } from "../../../../../lib/auth/csrf";
import { aspFetch, getAccountSession } from "../../../../../lib/account/asp";

/**
 * Approve or reject, forwarded to the ASP with the account bearer.
 *
 * `approvalDigest` is required in the body and is NOT defaulted here. Filling it in server-side from
 * whatever the ASP currently holds would silently reinstate the bug the digest exists to close: a
 * page rendered against a 6.00 quote, approved after the quote moved to 6.50, agreeing to a number
 * the user never saw. The browser echoes back the digest it was SHOWN, and a mismatch is a refusal
 * the user can act on.
 *
 * Same-origin is enforced explicitly rather than relying on the cookie's SameSite attribute, for the
 * reasons in `lib/auth/csrf.ts` — chiefly that Lax treats every subdomain as same-site.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ approvalRequestId: string }> },
): Promise<NextResponse> {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return NextResponse.json({ ok: false, code: "CROSS_ORIGIN", reason: origin.reason }, { status: 403 });
  }

  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json(
      {
        ok: false,
        code: "ACCOUNT_LINK_REQUIRED",
        message: "approvals are decided with the wallet that owns the account. Link your wallet first.",
      },
      { status: 401 },
    );
  }

  const { approvalRequestId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { decision?: string; approvalDigest?: string }
    | null;

  if (body?.decision !== "APPROVE" && body?.decision !== "REJECT") {
    return NextResponse.json(
      { ok: false, code: "DECISION_REQUIRED", message: 'decision must be "APPROVE" or "REJECT"' },
      { status: 400 },
    );
  }
  if (typeof body.approvalDigest !== "string" || body.approvalDigest === "") {
    return NextResponse.json(
      {
        ok: false,
        code: "APPROVAL_DIGEST_REQUIRED",
        message:
          "approvalDigest is required: a decision names the exact payment it authorises rather than agreeing to whatever is current",
      },
      { status: 400 },
    );
  }

  const result = await aspFetch(
    `/consumer/approvals/${encodeURIComponent(approvalRequestId)}/decide`,
    session,
    { method: "POST", body: JSON.stringify({ decision: body.decision, approvalDigest: body.approvalDigest }) },
  );
  return NextResponse.json(result.body as Record<string, unknown>, { status: result.status });
}
