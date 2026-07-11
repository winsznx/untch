import type { ReactNode } from "react";
import { DashCard } from "./ui";

/**
 * The honest empty state for a wallet with no Untch history (or a visitor who has not signed in). Shown
 * instead of the demo operator's seeded data, so the dashboard never presents one identity's history as
 * another's. States the connected address (if any) so it is unambiguous whose empty dashboard this is.
 */
export function NoHistory({
  authenticated,
  address,
  what = "activity",
  cta,
}: {
  authenticated: boolean;
  address: string | null;
  what?: string;
  cta?: ReactNode;
}) {
  return (
    <DashCard>
      <div className="flex flex-col gap-3">
        <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
          {authenticated ? `No ${what} for this wallet yet` : "Sign in to view your dashboard"}
        </span>
        <p className="max-w-xl text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
          {authenticated ? (
            <>
              The wallet{" "}
              <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--color-inverse-canvas)" }}>
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}
              </span>{" "}
              has no Untch history indexed. This dashboard shows only your own {what}; it never shows another
              operator&rsquo;s. Create a policy and run intents through it and they appear here.
            </>
          ) : (
            <>Connect your wallet and sign in from the bar above to see your own {what}. Public, verifiable
            proof for the whole system lives on the explorer.</>
          )}
        </p>
        {cta ? <div className="pt-1">{cta}</div> : null}
      </div>
    </DashCard>
  );
}
