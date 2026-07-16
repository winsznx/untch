import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "../../../../lib/auth/server";
import { isBindableChannel, submitDashboardCode } from "../../../../lib/dashboard/binding-runtime";

/**
 * Record a dashboard code-paste as an UNVERIFIED CLAIM on a handle.
 *
 * This route cannot verify a binding and does not pretend to. The code it accepts is one this same
 * dashboard minted and displayed to this same session moments ago, so echoing it back proves only that
 * the operator is that session — nothing about the Telegram/Discord/Slack handle they typed in. Real
 * verification needs the code to arrive FROM that handle, observed by that channel's receiver
 * (`verifyWithChannelProof`); that receiver is not built yet — internal/binding-lifecycle-audit.md, F1.
 *
 * The response therefore carries `unverified: true` and a status of `"unverified"`. It must not be
 * rendered as a completed binding, and nothing downstream may treat it as authority.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { channel?: string; code?: string } | null;
  if (!body?.channel || !isBindableChannel(body.channel) || !body.code?.trim()) {
    return NextResponse.json({ error: "channel and code required" }, { status: 400 });
  }
  const result = await submitDashboardCode({
    operatorId: session.operatorId,
    channel: body.channel,
    code: body.code,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
