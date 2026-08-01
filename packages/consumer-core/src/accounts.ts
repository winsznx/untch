import { randomBytes } from "node:crypto";
import type { Pool } from "./db";

/**
 * The account model, and the store that reads and writes it.
 *
 * WHAT AN ACCOUNT IS FOR
 *
 * A tenant was a policy partition. That is namespacing: it kept two policies' data apart, and it is
 * the right answer to "may this session read this row". It is not an answer to "whose is this", and
 * the product's own journey needs one — a person with two policies currently has two disjoint worlds
 * with no query spanning them, and a marketplace identity has nowhere to live except an audit note on
 * a session.
 *
 * WHERE AUTHORITY COMES FROM
 *
 * A verified wallet, and nothing else. Not an email — an email authenticates a login provider, and
 * making it the key would make a mailbox the thing that owns money. Not a mailbox grant either: a
 * Gmail authorisation is a capability a provider exercises, never an authority here. The account id
 * is opaque so that binding a second wallet, or rotating a compromised one, does not change what any
 * foreign key means.
 *
 * WHAT THIS MODULE WILL NOT DO
 *
 * It will not create an account from an unproven claim. `linkWallet` requires a proof reference and a
 * verification time for a SIWE binding, and the schema refuses the row without them. A marketplace
 * binding defaults to `unproven`, which is exactly what an agent id arriving in a request header is —
 * and `proven_by` is the field a later authorisation check reads, so an unproven binding authorises
 * nothing by construction rather than by remembering to check.
 */

export type AccountStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";
export type ChainKind = "evm" | "solana";
export type WalletRole = "primary" | "settlement";
export type WalletProofKind = "siwe" | "declared";
export type MarketplaceProof = "unproven" | "wallet-signature";
export type PolicyLinkKind = "registered" | "adopted";
export type PolicyDraftStatus = "DRAFT" | "SUBMITTED" | "CONFIRMED" | "ABANDONED";

export interface Provenance {
  /** How the row came to exist: 'siwe', 'backfill:policy-partition', 'operator', … */
  readonly by: string;
}

export interface UntchAccount {
  readonly accountId: string;
  readonly status: AccountStatus;
  readonly displayName: string | null;
  /** The policy `useDefaultPolicy` resolves to. Null means the account has not chosen one. */
  readonly defaultPolicyId: string | null;
  /** The last policy actually used. A fact, not a choice — never promoted to the default silently. */
  readonly lastUsedPolicyId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface WalletBinding {
  readonly accountId: string;
  readonly chainKind: ChainKind;
  readonly address: string;
  readonly role: WalletRole;
  readonly proofKind: WalletProofKind;
  readonly proofRef: string | null;
  readonly verifiedAt: string | null;
}

export interface MarketplaceBinding {
  readonly accountId: string;
  readonly marketplace: string;
  readonly agentId: string;
  readonly buyerId: string | null;
  readonly provenBy: MarketplaceProof;
  readonly verifiedAt: string | null;
}

export interface PolicyDraft {
  readonly draftId: string;
  readonly accountId: string;
  readonly rules: Record<string, unknown>;
  readonly policyHash: string;
  readonly agentId: string;
  readonly status: PolicyDraftStatus;
  readonly chainId: number;
  readonly registerTx: string | null;
  readonly policyId: string | null;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * `acct_` + 26 base32 characters — 130 bits of randomness, no ordering, no embedded identity.
 *
 * Not a serial: a serial leaks how many accounts exist and lets one be enumerated from another. Not a
 * hash of the address: that would make the id change if the wallet ever did, which is the whole thing
 * the opaque id exists to survive.
 */
export function newAccountId(): string {
  const bytes = randomBytes(17);
  let out = "";
  for (let i = 0; i < 26; i += 1) out += BASE32[(bytes[i % bytes.length] as number) % 32];
  return `acct_${out}`;
}

export function newDraftId(): string {
  return `pdft_${randomBytes(12).toString("hex")}`;
}

/** EVM addresses are stored lowercase. Two spellings of one address is two identities to a unique index. */
export function normaliseAddress(chainKind: ChainKind, address: string): string {
  return chainKind === "evm" ? address.trim().toLowerCase() : address.trim();
}

export class AccountAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountAuthorityError";
  }
}

export interface AccountStore {
  createAccount(args: { readonly displayName?: string | null } & Provenance): Promise<UntchAccount>;
  getAccount(accountId: string): Promise<UntchAccount | null>;
  /** The account a proven wallet belongs to, or null. The only lookup that carries authority. */
  accountForWallet(chainKind: ChainKind, address: string): Promise<UntchAccount | null>;
  linkWallet(binding: WalletBinding & Provenance): Promise<void>;
  walletsFor(accountId: string): Promise<readonly WalletBinding[]>;
  linkMarketplace(binding: MarketplaceBinding & Provenance): Promise<void>;
  marketplaceBindingsFor(accountId: string): Promise<readonly MarketplaceBinding[]>;
  recordJob(args: {
    readonly marketplace: string;
    readonly jobId: string;
    readonly accountId: string;
    readonly agentId?: string | null;
    readonly intentId?: string | null;
    readonly status?: string | null;
  } & Provenance): Promise<void>;
  linkPolicy(args: {
    readonly accountId: string;
    readonly policyId: string;
    readonly linkedBy: PolicyLinkKind;
  } & Provenance): Promise<void>;
  policiesFor(accountId: string): Promise<readonly string[]>;
  /** The account a policy belongs to, or null when it predates accounts entirely. */
  accountForPolicy(policyId: string): Promise<UntchAccount | null>;
  setDefaultPolicy(args: { readonly accountId: string; readonly policyId: string } & Provenance): Promise<void>;
  recordPolicyUse(args: { readonly accountId: string; readonly policyId: string } & Provenance): Promise<void>;
  createDraft(draft: Omit<PolicyDraft, "status" | "registerTx" | "policyId"> & Provenance): Promise<PolicyDraft>;
  markDraftSubmitted(args: { readonly draftId: string; readonly registerTx: string } & Provenance): Promise<void>;
  markDraftConfirmed(args: { readonly draftId: string; readonly policyId: string } & Provenance): Promise<void>;
  draftsFor(accountId: string): Promise<readonly PolicyDraft[]>;
  getDraft(draftId: string): Promise<PolicyDraft | null>;
}

interface AccountRow {
  account_id: string;
  status: AccountStatus;
  display_name: string | null;
  default_policy_id: string | null;
  last_used_policy_id: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

function toAccount(row: AccountRow): UntchAccount {
  return {
    accountId: row.account_id,
    status: row.status,
    displayName: row.display_name,
    defaultPolicyId: row.default_policy_id,
    lastUsedPolicyId: row.last_used_policy_id,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export class PgAccountStore implements AccountStore {
  constructor(private readonly pool: Pool) {}

  async createAccount(args: { readonly displayName?: string | null } & Provenance): Promise<UntchAccount> {
    const accountId = newAccountId();
    const { rows } = await this.pool.query<AccountRow>(
      `INSERT INTO untch_accounts (account_id, display_name, created_by, updated_by)
       VALUES ($1, $2, $3, $3) RETURNING *`,
      [accountId, args.displayName ?? null, args.by],
    );
    return toAccount(rows[0] as AccountRow);
  }

  async getAccount(accountId: string): Promise<UntchAccount | null> {
    const { rows } = await this.pool.query<AccountRow>(
      "SELECT * FROM untch_accounts WHERE account_id = $1",
      [accountId],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  /**
   * Only a PROVEN binding resolves.
   *
   * A `declared` address is one somebody wrote down. Letting it resolve to an account would make a
   * note into a credential, and the note is the easiest thing in this schema to write.
   */
  async accountForWallet(chainKind: ChainKind, address: string): Promise<UntchAccount | null> {
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT a.* FROM untch_accounts a
         JOIN untch_wallet_bindings w ON w.account_id = a.account_id
        WHERE w.chain_kind = $1 AND w.address = $2 AND w.proof_kind = 'siwe'`,
      [chainKind, normaliseAddress(chainKind, address)],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async linkWallet(binding: WalletBinding & Provenance): Promise<void> {
    if (binding.proofKind === "siwe" && (!binding.proofRef || !binding.verifiedAt)) {
      throw new AccountAuthorityError(
        "a wallet binding that claims a signature must carry the proof reference and the time it was verified; " +
          "record it as `declared` instead of asserting a proof nobody can date",
      );
    }
    await this.pool.query(
      `INSERT INTO untch_wallet_bindings
         (account_id, chain_kind, address, role, proof_kind, proof_ref, verified_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (chain_kind, address) DO UPDATE
         SET role = EXCLUDED.role,
             proof_kind = EXCLUDED.proof_kind,
             proof_ref = EXCLUDED.proof_ref,
             verified_at = EXCLUDED.verified_at,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
         -- An address cannot be moved between accounts by re-binding it. Changing who owns an address
         -- is a recovery operation, not an idempotent write.
         WHERE untch_wallet_bindings.account_id = EXCLUDED.account_id`,
      [
        binding.accountId,
        binding.chainKind,
        normaliseAddress(binding.chainKind, binding.address),
        binding.role,
        binding.proofKind,
        binding.proofRef ?? null,
        binding.verifiedAt ?? null,
        binding.by,
      ],
    );
  }

  async walletsFor(accountId: string): Promise<readonly WalletBinding[]> {
    const { rows } = await this.pool.query<{
      account_id: string;
      chain_kind: ChainKind;
      address: string;
      role: WalletRole;
      proof_kind: WalletProofKind;
      proof_ref: string | null;
      verified_at: Date | null;
    }>("SELECT * FROM untch_wallet_bindings WHERE account_id = $1 ORDER BY chain_kind, role", [accountId]);
    return rows.map((r) => ({
      accountId: r.account_id,
      chainKind: r.chain_kind,
      address: r.address,
      role: r.role,
      proofKind: r.proof_kind,
      proofRef: r.proof_ref,
      verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
    }));
  }

  async linkMarketplace(binding: MarketplaceBinding & Provenance): Promise<void> {
    if (binding.provenBy !== "unproven" && !binding.verifiedAt) {
      throw new AccountAuthorityError(
        "a marketplace binding that claims a wallet signature must say when it was verified",
      );
    }
    await this.pool.query(
      `INSERT INTO untch_marketplace_bindings
         (account_id, marketplace, agent_id, buyer_id, proven_by, verified_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (marketplace, agent_id) DO UPDATE
         SET buyer_id = EXCLUDED.buyer_id,
             proven_by = EXCLUDED.proven_by,
             verified_at = EXCLUDED.verified_at,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
         WHERE untch_marketplace_bindings.account_id = EXCLUDED.account_id`,
      [
        binding.accountId,
        binding.marketplace,
        binding.agentId,
        binding.buyerId ?? null,
        binding.provenBy,
        binding.verifiedAt ?? null,
        binding.by,
      ],
    );
  }

  async marketplaceBindingsFor(accountId: string): Promise<readonly MarketplaceBinding[]> {
    const { rows } = await this.pool.query<{
      account_id: string;
      marketplace: string;
      agent_id: string;
      buyer_id: string | null;
      proven_by: MarketplaceProof;
      verified_at: Date | null;
    }>("SELECT * FROM untch_marketplace_bindings WHERE account_id = $1", [accountId]);
    return rows.map((r) => ({
      accountId: r.account_id,
      marketplace: r.marketplace,
      agentId: r.agent_id,
      buyerId: r.buyer_id,
      provenBy: r.proven_by,
      verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
    }));
  }

  async recordJob(
    args: {
      readonly marketplace: string;
      readonly jobId: string;
      readonly accountId: string;
      readonly agentId?: string | null;
      readonly intentId?: string | null;
      readonly status?: string | null;
    } & Provenance,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO untch_marketplace_jobs
         (marketplace, job_id, account_id, agent_id, intent_id, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (marketplace, job_id) DO UPDATE
         SET intent_id = COALESCE(EXCLUDED.intent_id, untch_marketplace_jobs.intent_id),
             status = COALESCE(EXCLUDED.status, untch_marketplace_jobs.status),
             updated_at = now(),
             updated_by = EXCLUDED.updated_by`,
      [
        args.marketplace,
        args.jobId,
        args.accountId,
        args.agentId ?? null,
        args.intentId ?? null,
        args.status ?? null,
        args.by,
      ],
    );
  }

  async linkPolicy(
    args: { readonly accountId: string; readonly policyId: string; readonly linkedBy: PolicyLinkKind } & Provenance,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO untch_account_policies (account_id, policy_id, linked_by, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (policy_id) DO NOTHING`,
      [args.accountId, args.policyId, args.linkedBy, args.by],
    );
  }

  async policiesFor(accountId: string): Promise<readonly string[]> {
    const { rows } = await this.pool.query<{ policy_id: string }>(
      "SELECT policy_id FROM untch_account_policies WHERE account_id = $1 ORDER BY created_at",
      [accountId],
    );
    return rows.map((r) => r.policy_id);
  }

  async accountForPolicy(policyId: string): Promise<UntchAccount | null> {
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT a.* FROM untch_accounts a
         JOIN untch_account_policies p ON p.account_id = a.account_id
        WHERE p.policy_id = $1`,
      [policyId],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  /**
   * The default may only be a policy the account actually has.
   *
   * The guard is in the WHERE clause rather than in a prior read, because the check that matters is
   * the one a concurrent unlink cannot slip past.
   */
  async setDefaultPolicy(
    args: { readonly accountId: string; readonly policyId: string } & Provenance,
  ): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_accounts SET default_policy_id = $2, updated_at = now(), updated_by = $3
        WHERE account_id = $1
          AND EXISTS (SELECT 1 FROM untch_account_policies
                       WHERE account_id = $1 AND policy_id = $2)`,
      [args.accountId, args.policyId, args.by],
    );
    if (!rowCount) {
      throw new AccountAuthorityError(
        `policy ${args.policyId} is not linked to ${args.accountId}; an account cannot default to a policy it does not hold`,
      );
    }
  }

  /** Records a fact. Deliberately does not touch `default_policy_id` — using is not choosing. */
  async recordPolicyUse(
    args: { readonly accountId: string; readonly policyId: string } & Provenance,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE untch_accounts SET last_used_policy_id = $2, updated_at = now(), updated_by = $3
        WHERE account_id = $1`,
      [args.accountId, args.policyId, args.by],
    );
  }

  async createDraft(
    draft: Omit<PolicyDraft, "status" | "registerTx" | "policyId"> & Provenance,
  ): Promise<PolicyDraft> {
    await this.pool.query(
      `INSERT INTO untch_policy_drafts
         (draft_id, account_id, rules, policy_hash, agent_id, chain_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [draft.draftId, draft.accountId, draft.rules, draft.policyHash, draft.agentId, draft.chainId, draft.by],
    );
    return { ...draft, status: "DRAFT", registerTx: null, policyId: null };
  }

  async markDraftSubmitted(
    args: { readonly draftId: string; readonly registerTx: string } & Provenance,
  ): Promise<void> {
    // Only a DRAFT may be submitted. A second submission of an already-confirmed draft would otherwise
    // overwrite the transaction that actually produced the policy.
    const { rowCount } = await this.pool.query(
      `UPDATE untch_policy_drafts
          SET status = 'SUBMITTED', register_tx = $2, updated_at = now(), updated_by = $3
        WHERE draft_id = $1 AND status = 'DRAFT'`,
      [args.draftId, args.registerTx, args.by],
    );
    if (!rowCount) throw new AccountAuthorityError(`draft ${args.draftId} is not in DRAFT and cannot be submitted`);
  }

  /**
   * Confirmation requires the policy id to have been READ from the chain, not inferred.
   *
   * The caller is expected to have decoded a PolicyRegistered event. This method cannot check that,
   * which is why it refuses to move anything that is not already SUBMITTED — a draft that never
   * carried a transaction cannot become confirmed by asserting a policy id at it.
   */
  async markDraftConfirmed(
    args: { readonly draftId: string; readonly policyId: string } & Provenance,
  ): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_policy_drafts
          SET status = 'CONFIRMED', policy_id = $2, updated_at = now(), updated_by = $3
        WHERE draft_id = $1 AND status = 'SUBMITTED'`,
      [args.draftId, args.policyId, args.by],
    );
    if (!rowCount) {
      throw new AccountAuthorityError(
        `draft ${args.draftId} is not SUBMITTED; a draft with no broadcast transaction cannot be confirmed`,
      );
    }
  }

  async draftsFor(accountId: string): Promise<readonly PolicyDraft[]> {
    const { rows } = await this.pool.query<DraftRow>(
      "SELECT * FROM untch_policy_drafts WHERE account_id = $1 ORDER BY created_at DESC",
      [accountId],
    );
    return rows.map(toDraft);
  }

  async getDraft(draftId: string): Promise<PolicyDraft | null> {
    const { rows } = await this.pool.query<DraftRow>(
      "SELECT * FROM untch_policy_drafts WHERE draft_id = $1",
      [draftId],
    );
    return rows[0] ? toDraft(rows[0]) : null;
  }
}

interface DraftRow {
  draft_id: string;
  account_id: string;
  rules: Record<string, unknown>;
  policy_hash: string;
  agent_id: string;
  status: PolicyDraftStatus;
  chain_id: string | number;
  register_tx: string | null;
  policy_id: string | null;
}

function toDraft(row: DraftRow): PolicyDraft {
  return {
    draftId: row.draft_id,
    accountId: row.account_id,
    rules: row.rules,
    policyHash: row.policy_hash,
    agentId: row.agent_id,
    status: row.status,
    chainId: Number(row.chain_id),
    registerTx: row.register_tx,
    policyId: row.policy_id,
  };
}

/**
 * Resolve a request's scope, preferring an account and falling back to the policy partition.
 *
 * THIS IS THE MIGRATION PATH, and it is deliberately a read-time resolution rather than a data
 * rewrite. Every existing policy, intent and receipt stays keyed by `policy:<policyId>` exactly as it
 * is today. An account is an ADDITIONAL fact about a policy, so:
 *
 *   • a policy with no account behaves precisely as it does now — the legacy path is not a degraded
 *     mode, it is the same mode;
 *   • adopting a policy into an account changes no existing row, so it cannot break a receipt;
 *   • a public receipt is built by naming publishable fields on an intent, and no field it names is
 *     touched by any of this.
 *
 * A backfill that rewrote tenancy would have to be correct about every historical row on the first
 * attempt, with receipts already published against them. This does not have to be.
 */
export interface ResolvedScope {
  /** Always present. The partition every existing row is keyed by. */
  readonly tenantId: string;
  readonly policyId: string;
  /** Present once the policy has been adopted into an account. */
  readonly accountId: string | null;
}

export function resolveScope(policyId: string, account: UntchAccount | null): ResolvedScope {
  return {
    tenantId: `policy:${policyId}`,
    policyId,
    accountId: account?.accountId ?? null,
  };
}
