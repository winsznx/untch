import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "../../../lib/auth/server";
import { isBindableChannel, listBindings, startBinding } from "../../../lib/dashboard/binding-runtime";

/** GET — the signed-in operator's channel bindings. POST — start a new binding (mint a code). */
export async function GET(): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.json({ bindings: listBindings(session.operatorId) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { channel?: string; handle?: string } | null;
  if (!body?.channel || !isBindableChannel(body.channel) || !body.handle?.trim()) {
    return NextResponse.json({ error: "channel (telegram|discord|slack) and handle required" }, { status: 400 });
  }
  try {
    const started = startBinding({ operatorId: session.operatorId, channel: body.channel, handle: body.handle });
    return NextResponse.json(started);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
