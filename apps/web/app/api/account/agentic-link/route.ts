import { NextResponse, type NextRequest } from "next/server";
import { checkSameOrigin } from "../../../../lib/auth/csrf";
import { aspFetch } from "../../../../lib/account/asp";

/**
 * Start an Agentic Wallet link, and poll it.
 *
 * POST starts. GET polls. Neither carries a credential, because neither has one to carry: the link
 * request id is an opaque 130-bit handle and the authority is a signature the agent will produce
 * elsewhere. The account session that results is handed to the AGENT, not to this browser, which is
 * why the browser reloads on LINKED and reads its own cookie state afresh rather than being handed a
 * token through a poll.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return NextResponse.json({ ok: false, code: "CROSS_ORIGIN", reason: origin.reason }, { status: 403 });
  }
  const started = await aspFetch<Record<string, unknown>>("/consumer/account/agentic-link/start", null, {
    method: "POST",
    body: JSON.stringify({ requestedScopes: ["identity", "policy-authority"] }),
  });
  return NextResponse.json(started.body as Record<string, unknown>, { status: started.status });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const id = req.nextUrl.searchParams.get("linkRequestId");
  if (!id) {
    return NextResponse.json({ code: "LINK_REQUEST_ID_REQUIRED", message: "linkRequestId is required" }, { status: 400 });
  }
  const status = await aspFetch<Record<string, unknown>>(
    `/consumer/account/agentic-link/${encodeURIComponent(id)}/status`,
    null,
  );
  return NextResponse.json(status.body as Record<string, unknown>, { status: status.status });
}
