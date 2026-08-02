/**
 * Read the account surface, and print nothing that could be used to act as it.
 *
 * WHY A SCRIPT WHEN THERE IS A PAGE
 *
 * `/account` shows this to the person holding the wallet. This shows it to an operator who needs to
 * confirm what actually landed in Postgres after a link, without holding a session and without
 * anybody pasting a bearer token into a terminal. The two answer the same question from different
 * sides of the authority boundary, which is why neither replaces the other.
 *
 * WHAT IS DELIBERATELY NOT PRINTED
 *
 * `proof_ref` is the SIWE nonce the binding was established with. It is single-use and already
 * redeemed, so printing it leaks nothing exploitable — and it is redacted anyway, because a value
 * that appears in a terminal appears in a scrollback, a screenshot and a support ticket, and the
 * habit of printing "harmless" credentials is what eventually prints one that is not. Bearer tokens
 * and one-time codes are never stored in a readable form to begin with: the code is hashed, and no
 * read of any kind can produce it.
 *
 *   PGURL="$(railway variables --service Postgres --environment production --kv \\
 *     | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" pnpm tsx scripts/account-status.ts
 */

export {};

import { createPool } from "../packages/consumer-core/src/db";
import { rolesOf } from "../packages/shared/src/role-addresses";

const REDACTED = "[redacted: single-use nonce, never printed]";

interface AccountRow {
  account_id: string;
  status: string;
  display_name: string | null;
  default_policy_id: string | null;
  last_used_policy_id: string | null;
  primary_wallet_binding_id: string | null;
  last_authenticated_at: Date | null;
  created_at: Date;
}

interface WalletRow {
  binding_id: string;
  account_id: string;
  chain_kind: string;
  address: string;
  role: string;
  proof_kind: string;
  scopes: string[] | null;
  binding_kind: string | null;
  agentic_selected_wallet: string | null;
  agentic_auth_method: string | null;
  agentic_solana_address: string | null;
  agentic_tool_version: string | null;
  challenge_ref: string | null;
  challenge_transport: string | null;
  status: string;
  verified_at: Date | null;
  revoked_at: Date | null;
}

interface MarketplaceRow {
  binding_id: string;
  account_id: string;
  marketplace: string;
  agent_id: string;
  buyer_id: string | null;
  proven_by: string;
  status: string;
}

interface PolicyRow {
  id: string;
  owner: string;
  agent_id: string;
  status: string;
  policy_hash: string;
  version: number;
  expiry: string;
}

async function main(): Promise<void> {
  const url = process.env.PGURL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("set PGURL (or DATABASE_URL). This script only reads; it issues no write of any kind.");
    process.exit(2);
    return;
  }

  // The workspace pool, so this reads through the same client configuration the service uses rather
  // than a second one with its own idea of TLS.
  const client = createPool(url);
  try {
    const accounts = (await client.query<AccountRow>("select * from untch_accounts order by created_at")).rows;
    const wallets = (await client.query<WalletRow>("select * from untch_wallet_bindings order by created_at")).rows;
    const marketplaces = (
      await client.query<MarketplaceRow>("select * from untch_marketplace_bindings order by created_at")
    ).rows;

    if (accounts.length === 0) {
      console.log("NO ACCOUNTS.");
      console.log("");
      console.log("  untch_accounts is empty, so there is no wallet binding and no user-owned policy.");
      console.log("  A wallet has to sign in before any of those can exist. One signature, at /approvals.");
      return;
    }

    for (const a of accounts) {
      const mine = wallets.filter((w: WalletRow) => w.account_id === a.account_id);
      const active = mine.filter((w: WalletRow) => w.status === "ACTIVE");
      const markets = marketplaces.filter((m: MarketplaceRow) => m.account_id === a.account_id);

      console.log(`accountId              ${a.account_id}`);
      console.log(`status                 ${a.status}`);
      console.log(`displayName            ${a.display_name ?? "(none)"}`);
      console.log(`createdAt              ${a.created_at.toISOString()}`);
      console.log(`lastAuthenticatedAt    ${a.last_authenticated_at?.toISOString() ?? "(never)"}`);
      console.log(`primaryWalletBindingId ${a.primary_wallet_binding_id ?? "(none)"}`);
      console.log("");

      console.log(`wallets (${active.length} active of ${mine.length})`);
      for (const w of mine) {
        const roles = rolesOf(w.address);
        const kind = w.binding_kind ?? "browser";
        console.log(`  bindingId            ${w.binding_id}`);
        console.log(`  bindingKind          ${kind}${kind === "agentic" ? " (OKX Onchain OS Agentic Wallet, TEE-held)" : " (injected browser provider)"}`);
        console.log(`  address              ${w.address}`);
        console.log(`  chain                ${w.chain_kind}`);
        console.log(`  role                 ${w.role}`);
        console.log(`  proofMethod          ${w.proof_kind}${w.proof_kind === "siwe" ? " (EIP-4361 over personal_sign)" : ""}`);
        console.log(`  proofRef             ${REDACTED}`);
        console.log(`  scopes               ${(w.scopes ?? []).join(", ") || "(none)"}`);
        console.log(`  verifiedAt           ${w.verified_at?.toISOString() ?? "(not recorded)"}`);
        console.log(`  status               ${w.status}${w.revoked_at ? ` (revoked ${w.revoked_at.toISOString()})` : ""}`);
        if (kind === "agentic") {
          // The Onchain OS account id is deliberately absent. The wallet skill's own rule is that the
          // account NAME is displayable and the id is not, and this surface has no reason to differ.
          console.log(`  agenticWallet        ${w.agentic_selected_wallet ?? "(unnamed)"}`);
          console.log(`  authMethod           ${w.agentic_auth_method ?? "(unrecorded)"} — access to the wallet, never spending authority`);
          console.log(`  solanaAddress        ${w.agentic_solana_address ?? "(none reported)"}`);
          console.log(`  toolVersion          ${w.agentic_tool_version ?? "(unrecorded)"}`);
        }
        console.log(`  challengeRef         ${w.challenge_ref ?? "(none)"}`);
        console.log(`  challengeTransport   ${w.challenge_transport ?? "(unrecorded)"}`);
        if (roles.length > 0) {
          // Should be impossible after the link guard. Printed loudly if it ever is not, because a
          // binding that predates the guard would be invisible otherwise.
          console.log(`  ⚠ OPERATIONAL ROLE   ${roles.map((r) => r.role).join(", ")} — this must not be a user wallet`);
        }
        console.log("");
      }

      console.log("default policy");
      if (!a.default_policy_id) {
        console.log("  (none chosen). A request with no policyId will answer POLICY_REQUIRED.");
      } else {
        const p = (
          await client.query<PolicyRow>("select * from policies where id = $1", [a.default_policy_id])
        ).rows[0];
        console.log(`  policyId             ${a.default_policy_id}`);
        if (!p) {
          console.log("  ⚠ that id is not in the policy store");
        } else {
          const ownerIsAccounts = active.some((w: WalletRow) => w.address.toLowerCase() === p.owner.toLowerCase());
          console.log(`  owner                ${p.owner}${ownerIsAccounts ? " (a wallet this account has proven)" : " ⚠ NOT a wallet of this account"}`);
          console.log(`  governedAgent        ${p.agent_id}`);
          console.log(`  status               ${p.status}`);
          console.log(`  version              ${p.version}`);
          console.log(`  policyHash           ${p.policy_hash}`);
          console.log(`  expiry               ${new Date(Number(p.expiry) * 1000).toISOString()}`);
        }
      }
      console.log(`lastUsedPolicyId       ${a.last_used_policy_id ?? "(none)"}`);
      console.log("");

      console.log(`marketplace bindings (${markets.length})`);
      for (const m of markets) {
        console.log(`  ${m.marketplace} agent ${m.agent_id} — provenBy ${m.proven_by}, ${m.status}`);
        if (m.proven_by !== "wallet-signature") {
          console.log("    (audit context only. An agent id authorises nothing until a wallet signs for it.)");
        }
      }
      if (markets.length === 0) console.log("  (none)");
      console.log("");
      console.log("─".repeat(72));
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("account-status failed:", (err as Error).message);
  process.exit(1);
});
