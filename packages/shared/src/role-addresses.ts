/**
 * The addresses this deployment operates, named by role, so no one of them can stand in for another.
 *
 * WHY THIS FILE EXISTS
 *
 * Five distinct roles were being satisfied by whichever address happened to already be configured:
 *
 *   • the DEPLOYER, which is also this host's marketplace `payTo`;
 *   • the RECEIPT WRITER, which the policy-draft route was defaulting to as a user's governed agent;
 *   • the OPERATOR / demo wallet, which owns nine of the ten policies in production;
 *   • the CONSUMER POLICY OWNER, a server-held key that owns the tenth;
 *   • the ORACLE and ADMIN keys.
 *
 * None of that was malicious and all of it was reachable, because the roles were only ever separated
 * in prose. An address is a bearer token for whatever role reads it, and "we already have a wallet
 * configured" is the reasoning that turns five roles into one key.
 *
 * WHAT THE GUARD IS FOR
 *
 * `PolicyRegistry.registerPolicy` makes `msg.sender` the owner, permanently and with no relayer. So
 * the single most consequential role confusion available is registering a user's policy from an Untch
 * key: the policy is then owned by Untch, the user cannot pause or update it, and every later screen
 * that says "your policy" is wrong. `assertNotOperatorRole` is what makes that a refusal rather than
 * a decision somebody has to remember to get right.
 *
 * WHAT IT IS NOT
 *
 * A permission system. These addresses are public; the list adds no secrecy and removes no capability
 * from whoever holds a key. It closes exactly one failure: a role being filled by an address that
 * already has a different job, because that address was in scope.
 */

import type { Address } from "viem";

/** What an address is FOR here. One address, one role — the invariant this module exists to hold. */
export type UntchRole =
  | "deployer"
  | "marketplace-pay-to"
  | "receipt-writer"
  | "intent-writer"
  | "oracle"
  | "admin"
  | "contract-owner"
  | "operator-demo"
  | "consumer-policy-owner"
  | "base-treasury";

export interface RoleAddress {
  readonly role: UntchRole;
  readonly address: string;
  /** What it does, and — where it matters — what it must never be used as. */
  readonly what: string;
}

/**
 * Every operational address this deployment is known to control, lowercased.
 *
 * Sourced from `deployments/mainnet-suite.json` and from the addresses observed owning policies in
 * production. Written out rather than read from an environment, because the point is to refuse an
 * address even on a host where the corresponding variable is not set — a guard that only fires where
 * the key is configured is a guard that does not fire on the machine doing the damage.
 */
export const UNTCH_ROLE_ADDRESSES: readonly RoleAddress[] = Object.freeze([
  {
    role: "deployer",
    address: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
    what: "deployed the mainnet contract suite; also this host's marketplace payTo. Never a user's policy owner or governed agent.",
  },
  {
    role: "marketplace-pay-to",
    address: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
    what: "receives x402 marketplace billing for calls to this ASP. It is where OUR invoices are paid, and it is not a provider's recipient.",
  },
  {
    role: "contract-owner",
    address: "0x37b1a5ce095c33519553b32e15955bd0647c45f2",
    what: "owns the deployed contracts through the timelock. Governs the protocol, never a user's spending.",
  },
  {
    role: "oracle",
    address: "0xb29516c8c5dfc29a9e3f68f6e92fd1b6c7612d61",
    what: "signs Mode C spend authorisations. Holds no policy.",
  },
  { role: "admin", address: "0x4de912b84c54f6855114519795a1afca82dd2d19", what: "administrative role on the contract suite." },
  {
    role: "receipt-writer",
    address: "0xeedda7d18a34a93f3a722eb4446a526af515457a",
    what: "anchors receipts on UntchReceipts. It witnesses spending; it never performs or governs any.",
  },
  {
    role: "operator-demo",
    address: "0x98f43eabcad380f4f1f0587ae945bc8c79e43c0b",
    what: "the interim operator/demo wallet. Owns nine legacy policies, which is exactly the state the account model replaces.",
  },
  {
    role: "consumer-policy-owner",
    address: "0xaba5506df60d40436e002aee705c07dff99cb582",
    what: "a SERVER-HELD key that owns one legacy policy. A policy it owns is owned by Untch, not by a user.",
  },
  {
    role: "base-treasury",
    address: "0x0e79371813e88f31c2b60c80bad391a952039095",
    what: "settles provider payments on Base. A treasury pays; it does not authorise.",
  },
]);

/** Every role this address fills, or an empty list when it is not one of ours. */
export function rolesOf(address: string): readonly RoleAddress[] {
  const a = address.trim().toLowerCase();
  return UNTCH_ROLE_ADDRESSES.filter((r) => r.address === a);
}

export function isUntchRoleAddress(address: string): boolean {
  return rolesOf(address).length > 0;
}

export class RoleCollisionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly address: string,
    public readonly roles: readonly RoleAddress[],
  ) {
    super(message);
    this.name = "RoleCollisionError";
  }
}

/**
 * Refuse an Untch operational address where a user address is required.
 *
 * `intendedUse` is in the message because the fix depends on it: for a policy owner the answer is
 * "sign in with your own wallet", and for a governed agent it is "name the agent whose spending this
 * governs". A generic "that address is not allowed" leaves the caller guessing which of their inputs
 * to change.
 */
export function assertNotOperatorRole(address: string, intendedUse: string): void {
  const roles = rolesOf(address);
  if (roles.length === 0) return;
  const named = roles.map((r) => r.role).join(" and ");
  throw new RoleCollisionError(
    "OPERATOR_ADDRESS_REFUSED",
    `${address} is an Untch operational address (${named}) and must not be used as ${intendedUse}. ` +
      `${roles[0]?.what ?? ""} Reusing it here would make Untch the party this record names, which is the ` +
      `one thing the account model exists to prevent.`,
    address.toLowerCase(),
    roles,
  );
}

/**
 * The five roles a payment touches, kept apart in words so they stay apart in code.
 *
 * Referenced from the policy draft response and from the service registry, so a reader deciding
 * "which address goes here" has one place that answers it.
 */
export const ROLE_DISTINCTIONS: Readonly<Record<string, string>> = Object.freeze({
  policyOwner:
    "The wallet that registered the policy and is the only party that may pause or update it. `msg.sender` at registration, permanently. Must be the user's own wallet.",
  governedAgent:
    "The address whose spending the policy is a statement about. Stored and emitted by PolicyRegistry as an on-chain declaration; no contract enforces it, which makes it a truth claim rather than a control.",
  serviceRecipient:
    "Who receives money for a specific service, read from that service's registered definition. A property of the service, never of the host.",
  marketplacePayTo:
    "Where callers pay THIS ASP's own x402 invoices. It bills for using Untch; it is not any provider's recipient and not any user's policy owner.",
  operatorOrDeployer:
    "Keys Untch uses to deploy, anchor, sign oracle attestations and administer contracts. None of them may own or be governed by a user's policy.",
});
