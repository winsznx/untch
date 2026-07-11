import { NextResponse } from "next/server";
import { getServerSession } from "../../../../lib/auth/server";

/** Who is signed in — the client hydrates its wallet state from this on load. */
export async function GET(): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ authenticated: false });
  return NextResponse.json({
    authenticated: true,
    address: session.address,
    operatorId: session.operatorId,
    chainId: session.chainId,
    expiresAt: session.expiresAt,
  });
}
