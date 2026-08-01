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
  /** Which wallet binding IS this account's authority — a decision, not a scan over role flags. */
  readonly primaryWalletBindingId: string | null;
  /** The last time a wallet actually proved itself. `updatedAt` moves for operator writes too. */
  readonly lastAuthenticatedAt: string | null;
  /** The policy `useDefaultPolicy` resolves to. Null means the account has not chosen one. */
  readonly defaultPolicyId: string | null;
  /** The last policy actually used. A fact, not a choice — never promoted to the default silently. */
  readonly lastUsedPolicyId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * What a binding is PERMITTED to do — never what it happens to be used for.
 *
 * `identity` proves who is asking. `policy-authority` may act as the owner of a policy. They are
 * separate values because a wallet that signed a sign-in message has not thereby consented to authorise
 * spending, and collapsing them would make every sign-in a spending grant.
 */
export type BindingScope = "identity" | "policy-authority";

export type BindingStatus = "ACTIVE" | "REVOKED";
export type MarketplaceBindingStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface WalletBinding {
  /** Nameable. `primaryWalletBindingId` points at this, and a revoke endpoint takes it. */
  readonly bindingId: string;
  readonly accountId: string;
  readonly chainKind: ChainKind;
  readonly address: string;
  readonly role: WalletRole;
  readonly proofKind: WalletProofKind;
  readonly proofRef: string | null;
  /** Which chain the proof named. A proof that cannot say is a proof nobody can re-check. */
  readonly proofChainId: number | null;
  /** 'okx-agentic-wallet' | 'injected' | 'unknown'. Decides which proof methods are even available. */
  readonly walletProvider: string;
  readonly scopes: readonly BindingScope[];
  readonly status: BindingStatus;
  readonly verifiedAt: string | null;
  readonly revokedAt: string | null;
}

export interface MarketplaceBinding {
  readonly bindingId: string;
  readonly accountId: string;
  readonly marketplace: string;
  readonly agentId: string;
  readonly buyerId: string | null;
  readonly marketplaceUserRef: string | null;
  readonly serviceOrderRef: string | null;
  readonly taskRef: string | null;
  readonly bindingMethod: string;
  readonly provenBy: MarketplaceProof;
  readonly status: MarketplaceBindingStatus;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * What a CALLER supplies to create a binding, as distinct from what a reader gets back.
 *
 * The read shape is complete on purpose — a reader must never have to guess whether a binding is
 * revoked. The write shape is not, and forcing the two to be the same type would mean every caller
 * restating `status: "ACTIVE"` and `revokedAt: null` on a row that has just been created and cannot
 * be anything else. Worse, it would let a caller PASS `status: "REVOKED"` at creation, which is a
 * binding that was born already ended — expressible in the type, meaningless in the domain.
 *
 * The id defaults too. A caller that wants to name the binding it is about to create may pass one;
 * one that does not care gets a fresh opaque id rather than an accidental collision.
 */
export type WalletBindingInput = Omit<
  WalletBinding,
  "bindingId" | "status" | "revokedAt" | "proofChainId" | "walletProvider" | "scopes"
> &
  Partial<Pick<WalletBinding, "bindingId" | "proofChainId" | "walletProvider" | "scopes">>;

export type MarketplaceBindingInput = Omit<
  MarketplaceBinding,
  | "bindingId"
  | "status"
  | "revokedAt"
  | "marketplaceUserRef"
  | "serviceOrderRef"
  | "taskRef"
  | "bindingMethod"
  | "expiresAt"
> &
  Partial<
    Pick<
      MarketplaceBinding,
      "bindingId" | "marketplaceUserRef" | "serviceOrderRef" | "taskRef" | "bindingMethod" | "expiresAt"
    >
  >;

export type ChannelKind = "telegram" | "discord" | "email" | "dashboard";

export type ChannelBindingInput = Omit<ChannelBinding, "bindingId" | "status" | "revokedAt"> &
  Partial<Pick<ChannelBinding, "bindingId">>;

export interface ChannelBinding {
  readonly bindingId: string;
  readonly accountId: string;
  readonly channel: ChannelKind;
  readonly channelUserId: string;
  readonly channelChatId: string | null;
  readonly displayLabel: string | null;
  /**
   * Whether a DECISION may arrive from this channel. False for email, by design: a sender address is
   * forged trivially, so email carries a link to an authenticated session and never an answer.
   */
  readonly canDecide: boolean;
  readonly status: BindingStatus;
  readonly verifiedAt: string | null;
  readonly revokedAt: string | null;
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

export function newWalletBindingId(): string {
  return `wbnd_${randomBytes(16).toString("hex")}`;
}

export function newMarketplaceBindingId(): string {
  return `mbnd_${randomBytes(16).toString("hex")}`;
}

export function newChannelBindingId(): string {
  return `cbnd_${randomBytes(16).toString("hex")}`;
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
  /** `bound: false` means the address is already bound to a DIFFERENT account and was not moved. */
  linkWallet(binding: WalletBindingInput & Provenance): Promise<{ readonly bound: boolean }>;
  walletsFor(accountId: string): Promise<readonly WalletBinding[]>;
  walletBinding(bindingId: string): Promise<WalletBinding | null>;
  revokeWallet(args: { readonly bindingId: string } & Provenance): Promise<boolean>;
  setPrimaryWallet(args: { readonly accountId: string; readonly bindingId: string } & Provenance): Promise<void>;
  recordAuthentication(args: { readonly accountId: string } & Provenance): Promise<void>;
  linkMarketplace(binding: MarketplaceBindingInput & Provenance): Promise<{ readonly bound: boolean }>;
  marketplaceBindingsFor(accountId: string): Promise<readonly MarketplaceBinding[]>;
  accountForMarketplaceIdentity(
    marketplace: string,
    agentId: string,
  ): Promise<{ readonly account: UntchAccount; readonly binding: MarketplaceBinding } | null>;
  revokeMarketplace(args: { readonly bindingId: string } & Provenance): Promise<boolean>;
  linkChannel(binding: ChannelBindingInput & Provenance): Promise<{ readonly bound: boolean }>;
  channelsFor(accountId: string): Promise<readonly ChannelBinding[]>;
  decidingChannel(channel: ChannelKind, channelUserId: string): Promise<ChannelBinding | null>;
  revokeChannel(args: { readonly bindingId: string } & Provenance): Promise<boolean>;
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
  primary_wallet_binding_id: string | null;
  last_authenticated_at: Date | null;
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
    primaryWalletBindingId: row.primary_wallet_binding_id ?? null,
    lastAuthenticatedAt: row.last_authenticated_at ? row.last_authenticated_at.toISOString() : null,
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
        WHERE w.chain_kind = $1 AND w.address = $2 AND w.proof_kind = 'siwe' AND w.status = 'ACTIVE'`,
      [chainKind, normaliseAddress(chainKind, address)],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  /**
   * Bind a wallet, or refresh the binding that address already has on THIS account.
   *
   * The `WHERE account_id = EXCLUDED.account_id` on the upsert is what stops an address being moved
   * between accounts by re-binding it: a second account signing for an address already bound elsewhere
   * updates nothing and the caller is told so. Moving an address is a recovery operation with a human
   * in it, not an idempotent write that happens to have a surprising effect.
   *
   * A binding that is REVOKED is not refreshed either — the conflict target is the address, and a
   * revoked row still occupies it. Re-binding after revocation goes through `rebindWallet`, which is
   * explicit about resurrecting an authority somebody deliberately ended.
   */
  async linkWallet(binding: WalletBindingInput & Provenance): Promise<{ readonly bound: boolean }> {
    if (binding.proofKind === "siwe" && (!binding.proofRef || !binding.verifiedAt)) {
      throw new AccountAuthorityError(
        "a wallet binding that claims a signature must carry the proof reference and the time it was verified; " +
          "record it as `declared` instead of asserting a proof nobody can date",
      );
    }
    const { rowCount } = await this.pool.query(
      `INSERT INTO untch_wallet_bindings
         (binding_id, account_id, chain_kind, address, role, proof_kind, proof_ref, proof_chain_id,
          wallet_provider, scopes, status, verified_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12,$12)
       ON CONFLICT (chain_kind, address) DO UPDATE
         SET role = EXCLUDED.role,
             proof_kind = EXCLUDED.proof_kind,
             proof_ref = EXCLUDED.proof_ref,
             proof_chain_id = EXCLUDED.proof_chain_id,
             wallet_provider = EXCLUDED.wallet_provider,
             scopes = EXCLUDED.scopes,
             verified_at = EXCLUDED.verified_at,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
         WHERE untch_wallet_bindings.account_id = EXCLUDED.account_id
           AND untch_wallet_bindings.status = 'ACTIVE'`,
      [
        binding.bindingId ?? newWalletBindingId(),
        binding.accountId,
        binding.chainKind,
        normaliseAddress(binding.chainKind, binding.address),
        binding.role,
        binding.proofKind,
        binding.proofRef ?? null,
        binding.proofChainId ?? null,
        binding.walletProvider ?? "unknown",
        // A `primary` wallet IS the account's authority, so it carries policy authority by default.
        // A `settlement` wallet is one funds move through, which proves nothing about who may
        // authorise them — defaulting it to identity alone is the difference between a treasury key
        // that can be paid to and one that can sign for the account.
        [...(binding.scopes ?? (binding.role === "primary" ? ["identity", "policy-authority"] : ["identity"]))],
        binding.verifiedAt ?? null,
        binding.by,
      ],
    );
    return { bound: (rowCount ?? 0) === 1 };
  }

  async walletsFor(accountId: string): Promise<readonly WalletBinding[]> {
    const { rows } = await this.pool.query<WalletRow>(
      "SELECT * FROM untch_wallet_bindings WHERE account_id = $1 ORDER BY chain_kind, role",
      [accountId],
    );
    return rows.map(toWalletBinding);
  }

  async walletBinding(bindingId: string): Promise<WalletBinding | null> {
    const { rows } = await this.pool.query<WalletRow>(
      "SELECT * FROM untch_wallet_bindings WHERE binding_id = $1",
      [bindingId],
    );
    return rows[0] ? toWalletBinding(rows[0]) : null;
  }

  /**
   * End a binding without erasing it.
   *
   * The row stays REVOKED rather than being deleted, because a revoked binding is the answer to "who
   * could have authorised this, and until when". Deleting it makes an old receipt unexplainable: the
   * intent names an account, the account has no wallet that could have signed for it, and nothing
   * records that one ever did.
   */
  async revokeWallet(args: { readonly bindingId: string } & Provenance): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_wallet_bindings
          SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, updated_at = now(), updated_by = $2
        WHERE binding_id = $1 AND status = 'ACTIVE'`,
      [args.bindingId, args.by],
    );
    if ((rowCount ?? 0) === 1) {
      // An account must not keep pointing at an authority that no longer exists. Clearing the pointer
      // here rather than at read time means a stale primary cannot survive a code path that forgot.
      await this.pool.query(
        `UPDATE untch_accounts SET primary_wallet_binding_id = NULL, updated_at = now(), updated_by = $2
          WHERE primary_wallet_binding_id = $1`,
        [args.bindingId, args.by],
      );
    }
    return (rowCount ?? 0) === 1;
  }

  async setPrimaryWallet(args: { readonly accountId: string; readonly bindingId: string } & Provenance): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_accounts a
          SET primary_wallet_binding_id = $2, updated_at = now(), updated_by = $3
        WHERE a.account_id = $1
          AND EXISTS (SELECT 1 FROM untch_wallet_bindings w
                       WHERE w.binding_id = $2 AND w.account_id = $1 AND w.status = 'ACTIVE')`,
      [args.accountId, args.bindingId, args.by],
    );
    if (!rowCount) {
      throw new AccountAuthorityError(
        `binding ${args.bindingId} is not an active binding of ${args.accountId}; an account cannot make ` +
          "another account's wallet, or a revoked one, its authority",
      );
    }
  }

  /** Stamped only when a wallet actually proved itself. Never on an operator write. */
  async recordAuthentication(args: { readonly accountId: string } & Provenance): Promise<void> {
    await this.pool.query(
      `UPDATE untch_accounts SET last_authenticated_at = now(), updated_at = now(), updated_by = $2
        WHERE account_id = $1`,
      [args.accountId, args.by],
    );
  }

  async linkMarketplace(binding: MarketplaceBindingInput & Provenance): Promise<{ readonly bound: boolean }> {
    if (binding.provenBy !== "unproven" && !binding.verifiedAt) {
      throw new AccountAuthorityError(
        "a marketplace binding that claims a wallet signature must say when it was verified",
      );
    }
    const { rowCount } = await this.pool.query(
      `INSERT INTO untch_marketplace_bindings
         (binding_id, account_id, marketplace, agent_id, buyer_id, marketplace_user_ref, service_order_ref,
          task_ref, binding_method, proven_by, status, verified_at, expires_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12,$13,$13)
       ON CONFLICT (marketplace, agent_id) DO UPDATE
         SET buyer_id = COALESCE(EXCLUDED.buyer_id, untch_marketplace_bindings.buyer_id),
             marketplace_user_ref = COALESCE(EXCLUDED.marketplace_user_ref, untch_marketplace_bindings.marketplace_user_ref),
             service_order_ref = COALESCE(EXCLUDED.service_order_ref, untch_marketplace_bindings.service_order_ref),
             task_ref = COALESCE(EXCLUDED.task_ref, untch_marketplace_bindings.task_ref),
             binding_method = EXCLUDED.binding_method,
             proven_by = EXCLUDED.proven_by,
             verified_at = EXCLUDED.verified_at,
             expires_at = EXCLUDED.expires_at,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
         -- A marketplace identity cannot be silently moved to a second account. The refusal is the
         -- WHERE clause rather than a prior read, because the check that matters is the one two
         -- concurrent link completions cannot both pass.
         WHERE untch_marketplace_bindings.account_id = EXCLUDED.account_id
           AND untch_marketplace_bindings.status = 'ACTIVE'`,
      [
        binding.bindingId ?? newMarketplaceBindingId(),
        binding.accountId,
        binding.marketplace,
        binding.agentId,
        binding.buyerId ?? null,
        binding.marketplaceUserRef ?? null,
        binding.serviceOrderRef ?? null,
        binding.taskRef ?? null,
        // How it was bound defaults to what it proves. They are separate columns because a future
        // method could prove nothing new — `link-code` redemption shows the redeemer held the code.
        binding.bindingMethod ?? binding.provenBy,
        binding.provenBy,
        binding.verifiedAt ?? null,
        binding.expiresAt ?? null,
        binding.by,
      ],
    );
    return { bound: (rowCount ?? 0) === 1 };
  }

  async marketplaceBindingsFor(accountId: string): Promise<readonly MarketplaceBinding[]> {
    const { rows } = await this.pool.query<MarketplaceRow>(
      "SELECT * FROM untch_marketplace_bindings WHERE account_id = $1 ORDER BY created_at",
      [accountId],
    );
    return rows.map(toMarketplaceBinding);
  }

  /**
   * The account a marketplace identity resolves to — and ONLY when a wallet signed for it.
   *
   * `proven_by = 'wallet-signature'` is the whole guard. An `unproven` row exists so an agent id seen
   * in a header has somewhere to be recorded for audit; letting it resolve here would turn that audit
   * note into the credential it was written down to avoid being.
   */
  async accountForMarketplaceIdentity(
    marketplace: string,
    agentId: string,
  ): Promise<{ readonly account: UntchAccount; readonly binding: MarketplaceBinding } | null> {
    const { rows } = await this.pool.query<AccountRow & MarketplaceRow>(
      `SELECT a.*, m.* FROM untch_accounts a
         JOIN untch_marketplace_bindings m ON m.account_id = a.account_id
        WHERE m.marketplace = $1 AND m.agent_id = $2
          AND m.status = 'ACTIVE' AND m.proven_by = 'wallet-signature'
          AND (m.expires_at IS NULL OR m.expires_at > now())`,
      [marketplace, agentId],
    );
    const row = rows[0];
    if (!row) return null;
    return { account: toAccount(row), binding: toMarketplaceBinding(row) };
  }

  async revokeMarketplace(args: { readonly bindingId: string } & Provenance): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_marketplace_bindings
          SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, updated_at = now(), updated_by = $2
        WHERE binding_id = $1 AND status = 'ACTIVE'`,
      [args.bindingId, args.by],
    );
    return (rowCount ?? 0) === 1;
  }

  // ── channel bindings ────────────────────────────────────────────────────────

  async linkChannel(binding: ChannelBindingInput & Provenance): Promise<{ readonly bound: boolean }> {
    if (binding.canDecide && !binding.verifiedAt) {
      throw new AccountAuthorityError(
        "a channel that may decide must carry the time it was verified; an unverified decider is a " +
          "binding step that was skipped and an authority that was granted anyway",
      );
    }
    const { rowCount } = await this.pool.query(
      `INSERT INTO untch_channel_bindings
         (binding_id, account_id, channel, channel_user_id, channel_chat_id, display_label, can_decide,
          status, verified_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9,$9)
       ON CONFLICT DO NOTHING`,
      [
        binding.bindingId ?? newChannelBindingId(),
        binding.accountId,
        binding.channel,
        binding.channelUserId,
        binding.channelChatId ?? null,
        binding.displayLabel ?? null,
        binding.canDecide,
        binding.verifiedAt ?? null,
        binding.by,
      ],
    );
    return { bound: (rowCount ?? 0) === 1 };
  }

  async channelsFor(accountId: string): Promise<readonly ChannelBinding[]> {
    const { rows } = await this.pool.query<ChannelRow>(
      "SELECT * FROM untch_channel_bindings WHERE account_id = $1 ORDER BY channel, created_at",
      [accountId],
    );
    return rows.map(toChannelBinding);
  }

  /**
   * Which account, if any, this platform identity may decide for.
   *
   * `can_decide` is read here rather than inferred from the channel name, so an email binding cannot
   * acquire decision authority later by someone adding a reply parser somewhere else.
   */
  async decidingChannel(channel: ChannelKind, channelUserId: string): Promise<ChannelBinding | null> {
    const { rows } = await this.pool.query<ChannelRow>(
      `SELECT * FROM untch_channel_bindings
        WHERE channel = $1 AND channel_user_id = $2 AND status = 'ACTIVE' AND can_decide = true`,
      [channel, channelUserId],
    );
    return rows[0] ? toChannelBinding(rows[0]) : null;
  }

  async revokeChannel(args: { readonly bindingId: string } & Provenance): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_channel_bindings
          SET status = 'REVOKED', revoked_at = now(), updated_at = now(), updated_by = $2
        WHERE binding_id = $1 AND status = 'ACTIVE'`,
      [args.bindingId, args.by],
    );
    return (rowCount ?? 0) === 1;
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

interface WalletRow {
  binding_id: string;
  account_id: string;
  chain_kind: ChainKind;
  address: string;
  role: WalletRole;
  proof_kind: WalletProofKind;
  proof_ref: string | null;
  proof_chain_id: string | number | null;
  wallet_provider: string;
  scopes: string[];
  status: BindingStatus;
  verified_at: Date | null;
  revoked_at: Date | null;
}

function toWalletBinding(row: WalletRow): WalletBinding {
  return {
    bindingId: row.binding_id,
    accountId: row.account_id,
    chainKind: row.chain_kind,
    address: row.address,
    role: row.role,
    proofKind: row.proof_kind,
    proofRef: row.proof_ref,
    proofChainId: row.proof_chain_id === null ? null : Number(row.proof_chain_id),
    walletProvider: row.wallet_provider,
    scopes: row.scopes as readonly BindingScope[],
    status: row.status,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

interface MarketplaceRow {
  binding_id: string;
  account_id: string;
  marketplace: string;
  agent_id: string;
  buyer_id: string | null;
  marketplace_user_ref: string | null;
  service_order_ref: string | null;
  task_ref: string | null;
  binding_method: string;
  proven_by: MarketplaceProof;
  status: MarketplaceBindingStatus;
  verified_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function toMarketplaceBinding(row: MarketplaceRow): MarketplaceBinding {
  return {
    bindingId: row.binding_id,
    accountId: row.account_id,
    marketplace: row.marketplace,
    agentId: row.agent_id,
    buyerId: row.buyer_id,
    marketplaceUserRef: row.marketplace_user_ref,
    serviceOrderRef: row.service_order_ref,
    taskRef: row.task_ref,
    bindingMethod: row.binding_method,
    provenBy: row.proven_by,
    status: row.status,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

interface ChannelRow {
  binding_id: string;
  account_id: string;
  channel: ChannelKind;
  channel_user_id: string;
  channel_chat_id: string | null;
  display_label: string | null;
  can_decide: boolean;
  status: BindingStatus;
  verified_at: Date | null;
  revoked_at: Date | null;
}

function toChannelBinding(row: ChannelRow): ChannelBinding {
  return {
    bindingId: row.binding_id,
    accountId: row.account_id,
    channel: row.channel,
    channelUserId: row.channel_user_id,
    channelChatId: row.channel_chat_id,
    displayLabel: row.display_label,
    canDecide: row.can_decide,
    status: row.status,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
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
