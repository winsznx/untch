import Link from "next/link";
import { DashCard, SectionTitle } from "../../../components/dashboard/ui";
import { OnboardingFlow } from "../../../components/onboarding/onboarding-flow";
import { DEFAULT_POLICY_RULES } from "../../../lib/dashboard/data";
import { getScope } from "../../../lib/dashboard/scope";
import { hasAnyPolicy } from "../../../lib/dashboard/onboarding";

/**
 * The first-run onboarding path (Step-31). Overview redirects a first-time wallet here. It also lives in
 * the nav so anyone can revisit it. A wallet that already has an on-chain policy is not a first-timer, so
 * it sees a short "already set up" state instead of being walked through setup again.
 */
export const dynamic = "force-dynamic";

export default async function GetStarted() {
  const scope = await getScope();
  const alreadySetUp =
    scope.authenticated && scope.address ? scope.isDemoOperator || (await hasAnyPolicy(scope.address)) : false;

  return (
    <div className="flex flex-col gap-8">
      <SectionTitle
        kicker="Get started"
        title="Set up Untch in a few minutes"
        subtitle="Connect your wallet, choose how enforcement works, write your first policy, and bind a channel so you can approve payments. Every step here is real."
      />

      {alreadySetUp ? (
        <DashCard>
          <div className="flex flex-col gap-4">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>You are already set up</span>
            <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              This wallet already has a policy on-chain. Head to the dashboard to manage policies, channels,
              and vaults, or open the public explorer to see the receipts.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/dashboard"
                className="rounded-full px-4 py-2 text-body-sm"
                style={{ background: "var(--color-action)", color: "var(--color-text)", border: "1px solid var(--color-action)" }}
              >
                Go to dashboard
              </Link>
              <Link href="/dashboard/settings" className="text-body-sm underline-offset-4 hover:underline" style={{ color: "var(--color-data)" }}>
                Manage channels
              </Link>
            </div>
          </div>
        </DashCard>
      ) : (
        <OnboardingFlow initialRules={DEFAULT_POLICY_RULES} />
      )}
    </div>
  );
}
