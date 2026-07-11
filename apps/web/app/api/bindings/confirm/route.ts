import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "../../../../lib/auth/server";
import { confirmBinding, isBindableChannel } from "../../../../lib/dashboard/binding-runtime";

/** Confirm a pending binding by presenting the single-use code sent from the operator's handle. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { channel?: string; code?: string } | null;
  if (!body?.channel || !isBindableChannel(body.channel) || !body.code?.trim()) {
    return NextResponse.json({ error: "channel and code required" }, { status: 400 });
  }
  const result = await confirmBinding({ operatorId: session.operatorId, channel: body.channel, code: body.code });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
