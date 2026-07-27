import { DashCard } from "./ui";

/**
 * The refusal for a page that shows UNTCH'S OWN operational state rather than a tenant's data.
 *
 * This is a different refusal from `NoHistory`, and conflating the two would be a real mistake.
 * `NoHistory` says "you are signed in and you have nothing here" — an honest empty state for data
 * that is scoped to the caller. This says "this is not yours to see": the treasury float, its rail
 * addresses, the pause switches and the provider registry's provenance notes are not per-tenant, so
 * there is no per-tenant version of them to fall back to. An empty state would imply a scoped view
 * exists; a refusal is the truth.
 *
 * The pages this guards were shipping ungated — any visitor could read the settlement wallet
 * addresses, their balances and floors, which rails were paused, and the provenance notes that carry
 * settlement transaction hashes. None of that is secret in the cryptographic sense, and all of it is
 * an operational map of where Untch keeps money.
 */
export function OperatorOnly({
  authenticated,
  address,
  what,
}: {
  authenticated: boolean;
  address: string | null;
  what: string;
}) {
  return (
    <DashCard>
      <div className="flex flex-col gap-3">
        <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
          {authenticated ? "Operator access required" : "Sign in to continue"}
        </span>
        <p className="max-w-xl text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
          {authenticated ? (
            <>
              {what} is Untch&rsquo;s own operational state — settlement float, rail addresses, kill
              switches, integration provenance — not per-tenant data, so there is no version of this
              page scoped to{" "}
              <span style={{ fontFamily: "ui-monospace, monospace", color: "var(--color-inverse-canvas)" }}>
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "this wallet"}
              </span>
              . It is visible to the operator wallet only.
            </>
          ) : (
            <>
              {what} shows Untch&rsquo;s own operational state and is visible to the operator wallet
              only. Connect and sign in from the bar above. Public, verifiable proof for the whole
              system lives on the explorer.
            </>
          )}
        </p>
      </div>
    </DashCard>
  );
}
