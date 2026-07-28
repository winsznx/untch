import { NextResponse, type NextRequest } from "next/server";
import { checkSameOrigin } from "../../../../lib/auth/csrf";
import { getServerSession } from "../../../../lib/auth/server";
import { isBindableChannel, removeBinding } from "../../../../lib/dashboard/binding-runtime";

/** Remove a channel binding (pending or verified) for the signed-in operator. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // State-changing: same-origin only. SameSite=Lax already blocks a cross-site POST; this makes
  // the guarantee explicit so a future cookie change cannot remove it silently.
  const origin = checkSameOrigin(req);
  if (!origin.ok) {
    return NextResponse.json({ error: origin.reason }, { status: 403 });
  }

  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { channel?: string } | null;
  if (!body?.channel || !isBindableChannel(body.channel)) {
    return NextResponse.json({ error: "channel required" }, { status: 400 });
  }
  removeBinding(session.operatorId, body.channel);
  return NextResponse.json({ ok: true });
}
