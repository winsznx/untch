/**
 * Who is asking, what governs them, and which values production state actually determines.
 *
 * WHY THIS SITS BETWEEN THE REQUEST AND THE MAPPING
 *
 * `mapping.ts` already refuses to invent a value it cannot derive. What it could not do was DERIVE the
 * three values that turned out to matter most, because none of them is a property of the request:
 *
 *   • which policy judges this — a property of the account, when the caller did not name one;
 *   • which agent is spending — a property of the account's marketplace binding;
 *   • who gets paid — a property of the registered service definition, for a service Untch owns.
 *
 * So the old contract asked the caller for all three, and a caller who could not supply them was told
 * `AUTHORITY_NOT_DERIVABLE` and had nowhere to go. That refusal was honest and it was also the end of
 * the journey. This module is where the journey continues: it reads the account, the account's
 * bindings, the account's default policy and the service registry, and hands `mapping.ts` facts
 * instead of gaps.
 *
 * WHAT IT STILL REFUSES
 *
 * Everything the old code refused, by the same rule and with sharper names. An unproven marketplace
 * binding does not supply a buyer agent id — `provenBy: 'unproven'` is the schema saying the id
 * arrived in a header, and a header is a claim. A service with no deterministic recipient does not
 * borrow this host's payTo. A revoked wallet resolves to no account at all.
 *
 * THE ONE RULE THAT DECIDES EVERY CASE HERE
 *
 * A derivation reads state this server is the custodian of. An invention adds information nobody
 * supplied. Between the two there is no third category called "a sensible default", and every field
 * below is on one side of that line with the reason written down.
 */

import type { Address, Hex } from "viem";
import type {
  BindingScope,
  MarketplaceBinding,
  UntchAccount,
  WalletBinding,
} from "@untch/consumer-core";
import type { StoredPolicy } from "@untch/policy-store";
import type { ServiceDefinition } from "@untch/owned-work";
import { accountRefHash } from "@untch/consumer-core";
import type { MissingAuthority } from "./types";

/**
 * Every way a public preflight can end, named once.
 *
 * The three decision outcomes and the seven refusals are one union deliberately. A caller branches on
 * a single field, and the shape makes it impossible to return `ESCALATED` without an approval request
 * or `APPROVED_AUTOMATIC` with one — states that a boolean plus a nullable id would have allowed.
 *
 * `APPROVED_AUTOMATIC` says the policy decided on its own. It does NOT say anything was paid, and the
 * response that carries it says so in the same breath; see `executionPosture` on the handler.
 */
export type PreflightOutcomeCode =
  | "APPROVED_AUTOMATIC"
  | "ESCALATED"
  | "BLOCKED"
  | "ACCOUNT_LINK_REQUIRED"
  | "POLICY_REQUIRED"
  | "POLICY_INACTIVE"
  | "RECIPIENT_REQUIRED"
  | "AUTHORITY_NOT_DERIVABLE"
  | "QUOTE_REQUIRED"
  | "QUOTE_EXPIRED";

/** The HTTP status each outcome answers with. A refusal is not an error unless it is one. */
export const OUTCOME_STATUS: Readonly<Record<PreflightOutcomeCode, number>> = Object.freeze({
  APPROVED_AUTOMATIC: 200,
  ESCALATED: 200,
  BLOCKED: 200,
  ACCOUNT_LINK_REQUIRED: 401,
  POLICY_REQUIRED: 409,
  POLICY_INACTIVE: 409,
  RECIPIENT_REQUIRED: 409,
  AUTHORITY_NOT_DERIVABLE: 409,
  QUOTE_REQUIRED: 409,
  QUOTE_EXPIRED: 410,
});

/**
 * The service definition the resolver reads, named locally so the dependency direction is visible.
 *
 * It is `ServiceDefinition` from `@untch/owned-work` — the committed, reviewable record of what a
 * service Untch performs itself IS, including the address it is paid at. Aliasing rather than
 * re-declaring it means there is one definition of a service in the codebase, and the resolver cannot
 * drift from what the runtime actually runs.
 */
export type OwnedServiceDefinition = ServiceDefinition;

/**
 * The one thing this module needs from the policy store.
 *
 * Narrowed to a method rather than taking `PolicyProvider` whole so the resolver can be tested with a
 * table of policies and no Postgres. A test that has to construct a real provider to check "an expired
 * policy is refused" is a test nobody writes the second variant of.
 */
export interface StoredPolicyReader {
  loadStored(policyId: string): Promise<StoredPolicy | null>;
}

/**
 * The account facts the resolver reads, and nothing more.
 *
 * Four methods out of `AccountStore`'s thirty. Narrowing is what makes the refusal cases testable —
 * a revoked wallet, an unproven marketplace binding, a policy delegated but not owned — without
 * standing up a Postgres schema to express each one.
 */
export interface AccountFactsReader {
  getAccount(accountId: string): Promise<UntchAccount | null>;
  walletsFor(accountId: string): Promise<readonly WalletBinding[]>;
  marketplaceBindingsFor(accountId: string): Promise<readonly MarketplaceBinding[]>;
  policiesFor(accountId: string): Promise<readonly string[]>;
}

export interface AuthorityDeps {
  readonly accounts: AccountFactsReader;
  readonly policies: StoredPolicyReader;
  /** Owned-service lookup. Returns null for a capability this deployment does not perform itself. */
  readonly ownedService: (provider: string, capability: string) => OwnedServiceDefinition | null;
  readonly now: () => number;
}

/** What the caller proved before the request was read. Null when nothing was proven. */
export interface CallerIdentity {
  readonly accountId: string;
  readonly address: Address;
  readonly bindingId: string;
  readonly scopes: readonly BindingScope[];
}

export interface AuthorityRequest {
  readonly provider: string;
  readonly capability: string;
  readonly policyId?: string | undefined;
  readonly useDefaultPolicy?: boolean | undefined;
  /** A recipient constraint the caller set. Present means the caller decided; absent means derive. */
  readonly recipient?: string | undefined;
  /** Caller-supplied agent ids, honoured only where no binding contradicts them. */
  readonly buyerAgentId?: string | undefined;
  readonly workerAgentId?: string | undefined;
}

/**
 * WHO IS ASKING, AS A TYPE RATHER THAN AS A NULLABLE FIELD.
 *
 * The defect this closes: `buyerAgentId` was required of EVERY caller, including one whose policy
 * names their own wallet as both owner and governed agent and which has nothing to do with any
 * marketplace. The only two ways to obtain it were a wallet-proven marketplace binding — for which no
 * public route exists — and a caller-supplied claim. So a user who had done everything correctly, on
 * a policy they registered on-chain themselves, could not spend: the refusal named a predecessor
 * nobody could obtain. That is the exact "unobtainable predecessor" the registry's `predecessors`
 * field was built to expose, sitting on the money path.
 *
 * A nullable `buyerAgentId` would not have fixed it. Null means "absent", and absent is
 * indistinguishable from "a marketplace caller who forgot it" — so the check would either let a real
 * marketplace request through unidentified, or keep refusing the direct one. The two callers are
 * different KINDS, with different required facts, so the type says so and the resolver branches once.
 */
export type RequesterPrincipal =
  | {
      readonly kind: "untch_account";
      readonly accountId: string;
      readonly accountRefHash: Hex;
      readonly walletBindingId: string;
      readonly walletAddress: Address;
      readonly walletBindingKind: string;
      /** How the wallet proved itself. Only `siwe` is authority; `declared` is audit context. */
      readonly authorityProof: string;
      readonly scopes: readonly BindingScope[];
    }
  | {
      readonly kind: "marketplace_agent";
      readonly marketplace: string;
      readonly marketplaceBindingId: string;
      readonly buyerAgentId: string;
      readonly proofKind: string;
      /**
       * True ONLY for a wallet-signature binding. A declared id is recorded and reported, and it can
       * never satisfy a predecessor that asks for verified marketplace authority.
       */
      readonly verified: boolean;
      readonly accountId: string | null;
    };

export interface ResolvedAuthority {
  readonly account: UntchAccount;
  readonly wallet: WalletBinding;
  readonly policy: StoredPolicy;
  readonly marketplace: MarketplaceBinding | null;
  readonly requester: RequesterPrincipal;
  /**
   * Absent for a direct account request. It is NOT defaulted to a zero, to the ASP's own id, or to
   * the wallet address: each of those would receipt the decision against an agent that did not make
   * it, and a wallet address serialised into an agent-id field is a category error that hashes
   * cleanly.
   */
  readonly buyerAgentId: string | null;
  readonly workerAgentId: string;
  readonly recipient: Address | null;
  readonly recipientDerivedFrom: string | null;
  readonly ownedService: OwnedServiceDefinition | null;
  /** Every value this module produced, with what produced it. Returned to the caller verbatim. */
  readonly derived: readonly DerivedAuthorityField[];
}

export interface DerivedAuthorityField {
  readonly field: string;
  readonly value: string;
  readonly derivedFrom: string;
}

export type AuthorityOutcome =
  | { readonly ok: true; readonly authority: ResolvedAuthority }
  | {
      readonly ok: false;
      readonly code: PreflightOutcomeCode;
      readonly message: string;
      readonly missing: readonly MissingAuthority[];
      /** What the caller should do, as a route they can actually call. */
      readonly resolveBy: string | null;
    };

const UINT = /^[0-9]+$/;

const refuse = (
  code: PreflightOutcomeCode,
  message: string,
  missing: readonly MissingAuthority[] = [],
  resolveBy: string | null = null,
): AuthorityOutcome => ({ ok: false, code, message, missing, resolveBy });

/**
 * Resolve everything the request did not state.
 *
 * The order is not arbitrary: identity, then policy, then the money-shaped fields. Each step's refusal
 * would otherwise be reported as a later step's, and "no recipient" is a very different piece of advice
 * from "you are not signed in" even though both stop the same request.
 */
export async function resolveAuthority(
  request: AuthorityRequest,
  identity: CallerIdentity | null,
  deps: AuthorityDeps,
): Promise<AuthorityOutcome> {
  const derived: DerivedAuthorityField[] = [];
  const record = <T extends string>(field: string, value: T, derivedFrom: string): T => {
    derived.push({ field, value, derivedFrom });
    return value;
  };

  // ── 1. identity ───────────────────────────────────────────────────────────
  if (!identity) {
    return refuse(
      "ACCOUNT_LINK_REQUIRED",
      "this request needs an Untch account: the policy that governs it, the agent that spends under it " +
        "and the wallet that owns both are properties of an account, and none of them can be read from " +
        "an anonymous request",
      [
        {
          field: "accountId",
          why: "nothing in the request proves who is asking, and an account is not something a header can assert",
          resolvedFrom: "sign in with your wallet at POST /consumer/account/link/start, then send the session as `Authorization: Bearer <token>`",
        },
      ],
      "/consumer/account/link/start",
    );
  }

  const account = await deps.accounts.getAccount(identity.accountId);
  if (!account || account.status !== "ACTIVE") {
    return refuse(
      "ACCOUNT_LINK_REQUIRED",
      account
        ? `account ${account.accountId} is ${account.status} and authorises nothing`
        : "that session names an account that no longer exists",
      [],
      "/consumer/account/link/start",
    );
  }

  /**
   * The binding is re-read rather than trusted from the token.
   *
   * A session lives for minutes and a revocation is immediate. Reading the binding here is what makes
   * "revoke a compromised wallet" mean something before the token expires on its own — the alternative
   * is a window in which a wallet the user has already disowned still spends.
   */
  const wallets = await deps.accounts.walletsFor(account.accountId);
  const wallet = wallets.find((w) => w.bindingId === identity.bindingId);
  if (!wallet || wallet.status !== "ACTIVE") {
    return refuse(
      "ACCOUNT_LINK_REQUIRED",
      "the wallet this session was minted from is no longer an active binding on this account",
      [],
      "/consumer/account/link/start",
    );
  }
  if (wallet.proofKind !== "siwe") {
    // A `declared` binding is a note somebody typed. Resolving it would make a note into a credential.
    return refuse(
      "ACCOUNT_LINK_REQUIRED",
      "this wallet was declared, not proven. A declared binding is audit context; it authorises nothing",
      [],
      "/consumer/account/link/start",
    );
  }
  record("accountId", account.accountId, "the account the signed-in wallet resolves to");
  record("walletAddress", wallet.address, `the ${wallet.role} wallet proven by SIWE on this account`);

  // ── 2. policy ─────────────────────────────────────────────────────────────
  const selected = await selectPolicy(request, account, wallets, deps);
  if (!selected.ok) return selected;
  const policy = selected.policy;
  record("policyId", policy.id, selected.derivedFrom);
  record("policyHash", policy.policyHash, `the stored hash of policy ${policy.id}`);
  record("policyVersion", String(policy.version), `the stored version of policy ${policy.id}`);

  // ── 3. the marketplace identity, and what it is allowed to supply ─────────
  const bindings = await deps.accounts.marketplaceBindingsFor(account.accountId);
  const proven = bindings.find((b) => b.status === "ACTIVE" && b.provenBy === "wallet-signature") ?? null;
  const unproven = bindings.find((b) => b.status === "ACTIVE") ?? null;

  /**
   * WHICH KIND OF REQUESTER THIS IS, DECIDED BEFORE ANYTHING IS REQUIRED OF THEM.
   *
   * A request is a marketplace request when it carries marketplace identity — a proven binding on the
   * account, or a `buyerAgentId` the caller chose to send. Everything else is a direct account
   * request, and a direct account request has no buyer agent because there is no marketplace in it.
   *
   * Deciding the kind FIRST is the whole correction. The old code asked "can I produce a
   * buyerAgentId?" and treated the answer no as a failure of the request, when for a direct caller it
   * is a true and complete description of who they are.
   */
  const marketplaceIntent =
    proven !== null || (request.buyerAgentId !== undefined && request.buyerAgentId.trim() !== "");

  let requester: RequesterPrincipal;
  let buyerAgentId: string | null = null;

  if (!marketplaceIntent) {
    /**
     * ── DIRECT ACCOUNT AUTHORITY ──────────────────────────────────────────
     *
     * Everything required here has already been established above and is re-stated rather than
     * re-derived: the account is ACTIVE, the binding is ACTIVE, the proof is SIWE, and the policy
     * belongs to this account and to this wallet (checked in `selectPolicy`). What remains is the
     * scope: an `identity` binding proves who you are, and spending under a policy is a different
     * permission from proving a name.
     */
    if (!wallet.scopes.includes("policy-authority")) {
      return refuse(
        "AUTHORITY_NOT_DERIVABLE",
        "this wallet is bound for identity only: it proves who you are and does not carry authority " +
          "to spend under a policy",
        [
          {
            field: "scopes",
            why: `binding ${wallet.bindingId} has [${wallet.scopes.join(", ")}] and needs policy-authority`,
            resolvedFrom:
              "re-link this wallet requesting the policy-authority scope at POST /consumer/account/link/start",
          },
        ],
        "/consumer/account/link/start",
      );
    }

    requester = {
      kind: "untch_account",
      accountId: account.accountId,
      accountRefHash: accountRefHash(account.accountId),
      walletBindingId: wallet.bindingId,
      walletAddress: wallet.address as Address,
      walletBindingKind: wallet.bindingKind,
      authorityProof: wallet.proofKind,
      scopes: wallet.scopes,
    };
    record(
      "requesterPrincipal",
      "untch_account",
      `account ${account.accountId} acting through its own SIWE-proven ${wallet.bindingKind} wallet binding`,
    );
    // Deliberately NOT recorded as a derived field: there is no buyer agent to report, and reporting
    // an empty one would put the field back in every reader's mental model.
  } else if (proven && UINT.test(proven.agentId)) {
    buyerAgentId = record(
      "buyerAgentId",
      proven.agentId,
      `the ${proven.marketplace} agent id this account proved with a wallet signature`,
    );
    requester = {
      kind: "marketplace_agent",
      marketplace: proven.marketplace,
      marketplaceBindingId: proven.bindingId,
      buyerAgentId,
      proofKind: proven.provenBy,
      verified: true,
      accountId: account.accountId,
    };
    record("requesterPrincipal", "marketplace_agent", `wallet-proven ${proven.marketplace} binding`);
  } else if (request.buyerAgentId !== undefined && UINT.test(request.buyerAgentId.trim())) {
    /**
     * A caller-supplied id is accepted only when NO proven binding exists to contradict it, and it is
     * labelled as what it is. Preferring it over a proven binding would let a header override a
     * signature, which is the exact inversion the binding model exists to prevent.
     *
     * `verified: false` travels with it everywhere. A predecessor asking for VERIFIED marketplace
     * authority is not satisfied by this, and the type is what stops that being forgotten.
     */
    buyerAgentId = record(
      "buyerAgentId",
      request.buyerAgentId.trim(),
      "the buyer agent id you sent — this account has no wallet-proven marketplace binding, so it is recorded as a claim",
    );
    requester = {
      kind: "marketplace_agent",
      marketplace: unproven?.marketplace ?? "unknown",
      marketplaceBindingId: unproven?.bindingId ?? "",
      buyerAgentId,
      proofKind: unproven?.provenBy ?? "declared",
      verified: false,
      accountId: account.accountId,
    };
    record("requesterPrincipal", "marketplace_agent", "an unverified buyerAgentId claim in the request");
  } else {
    // A marketplace request whose id is not a uint. The kind was chosen from intent, so the refusal
    // names what a MARKETPLACE caller is missing rather than telling a direct caller to become one.
    return refuse(
      "AUTHORITY_NOT_DERIVABLE",
      "this request carries marketplace intent but no usable buyer agent id: a marketplace decision is " +
        "receipted against the agent that made it, and an unparseable id would name an agent that does not exist",
      [
        {
          field: "buyerAgentId",
          why: unproven
            ? `this account's ${unproven.marketplace} binding is ${unproven.provenBy}, which is audit context and not authority`
            : "the buyerAgentId sent is not a numeric agent id",
          resolvedFrom:
            "send a numeric buyerAgentId, which is recorded as a claim rather than as proof — or omit " +
            "it entirely and call as a direct Untch account, which needs no marketplace identity at all.",
        },
      ],
      null,
    );
  }

  // ── 4. the worker: who is being paid, and at what address ─────────────────
  const owned = deps.ownedService(request.provider, request.capability);
  if (owned && !owned.enabled) {
    return refuse(
      "AUTHORITY_NOT_DERIVABLE",
      `service ${owned.serviceId} is registered here but not enabled on this deployment`,
      [
        {
          field: "capability",
          why: `${request.provider}/${request.capability} resolves to ${owned.serviceId}@${owned.version}, which is switched off`,
          resolvedFrom: "an operator enabling the service definition",
        },
      ],
    );
  }

  let workerAgentId: string | null = null;
  if (owned?.workerAgentId && UINT.test(owned.workerAgentId)) {
    workerAgentId = record(
      "workerAgentId",
      owned.workerAgentId,
      `the registered agent id of owned service ${owned.serviceId}@${owned.version}`,
    );
  } else if (request.workerAgentId !== undefined && UINT.test(request.workerAgentId.trim())) {
    workerAgentId = record(
      "workerAgentId",
      request.workerAgentId.trim(),
      "the worker agent id you sent — no registration records one for this provider",
    );
  }

  if (workerAgentId === null) {
    return refuse(
      "AUTHORITY_NOT_DERIVABLE",
      "which agent is being paid cannot be derived: no registered service definition records an agent id " +
        "for this provider and capability, and none was sent",
      [
        {
          field: "workerAgentId",
          why: `no owned-service definition or provider registration names an agent id for ${request.provider}/${request.capability}`,
          resolvedFrom: "send workerAgentId, or register this provider's agent identity",
        },
      ],
    );
  }

  // ── 5. the recipient ──────────────────────────────────────────────────────
  const resolvedRecipient = resolveRecipient(request, owned, record);
  if (!resolvedRecipient.ok) return resolvedRecipient.outcome;

  return {
    ok: true,
    authority: {
      account,
      wallet,
      policy,
      // A direct account request reports NO marketplace, even when the account happens to hold an
      // unproven binding. Reporting one would attach a marketplace to a decision that was not made
      // through it, and every downstream reader would inherit the association.
      marketplace: requester.kind === "marketplace_agent" ? (proven ?? unproven) : null,
      requester,
      buyerAgentId,
      workerAgentId,
      recipient: resolvedRecipient.recipient,
      recipientDerivedFrom: resolvedRecipient.derivedFrom,
      ownedService: owned,
      derived,
    },
  };
}

type PolicySelection =
  | { readonly ok: true; readonly policy: StoredPolicy; readonly derivedFrom: string }
  | (AuthorityOutcome & { readonly ok: false });

/**
 * Which policy judges this, and whether this account may be judged by it.
 *
 * Two authority questions, not one. Ownership — the policy's on-chain owner is a wallet this account
 * has proven — is the strong form. Delegation — the account has the policy in its link table — covers
 * a policy an account adopted rather than registered. Neither is inferred from the other, and a policy
 * that satisfies neither is not this account's to spend under no matter how it was named.
 */
async function selectPolicy(
  request: AuthorityRequest,
  account: UntchAccount,
  wallets: readonly WalletBinding[],
  deps: AuthorityDeps,
): Promise<PolicySelection> {
  const explicit = request.policyId?.trim();
  const wantsDefault = request.useDefaultPolicy === true || (!explicit && request.useDefaultPolicy !== false);

  let policyId: string | null = null;
  let derivedFrom = "";
  if (explicit) {
    policyId = explicit;
    derivedFrom = "the policyId you sent";
  } else if (wantsDefault) {
    if (!account.defaultPolicyId) {
      return refuse(
        "POLICY_REQUIRED",
        "no policyId was sent and this account has not chosen a default policy. A request that silently " +
          "fell back to some policy would be a request whose limits nobody chose",
        [
          {
            field: "policyId",
            why: "this account's defaultPolicyId is null",
            resolvedFrom: "register a policy from your wallet at POST /consumer/policies/draft, then select it at PUT /consumer/account/default-policy",
          },
        ],
        "/consumer/policies/draft",
      ) as PolicySelection;
    }
    policyId = account.defaultPolicyId;
    derivedFrom = "the default policy this account selected";
  }

  if (!policyId) {
    return refuse("POLICY_REQUIRED", "send policyId, or useDefaultPolicy with a default selected", [], "/consumer/policies/draft") as PolicySelection;
  }

  const policy = await deps.policies.loadStored(policyId);
  if (!policy) {
    return refuse(
      "POLICY_REQUIRED",
      `no policy ${policyId} is stored here`,
      [{ field: "policyId", why: "the id does not resolve to a stored policy", resolvedFrom: "GET /consumer/policies" }],
      "/consumer/policies",
    ) as PolicySelection;
  }

  if (policy.status !== "ACTIVE") {
    return refuse(
      "POLICY_INACTIVE",
      `policy ${policy.id} is ${policy.status}; a paused or revoked policy authorises nothing`,
      [{ field: "policy.status", why: `stored status is ${policy.status}`, resolvedFrom: "POST /consumer/policies/resume, from the owning wallet" }],
    ) as PolicySelection;
  }

  const nowSeconds = Math.floor(deps.now() / 1000);
  if (policy.expiry > 0 && policy.expiry <= nowSeconds) {
    return refuse(
      "POLICY_INACTIVE",
      `policy ${policy.id} expired at ${new Date(policy.expiry * 1000).toISOString()}. An expired policy stops ` +
        "authorising with no transaction needed, which is the point of the expiry",
      [{ field: "policy.expiry", why: "the on-chain expiry has passed", resolvedFrom: "register a new policy, or update this one's expiry from the owning wallet" }],
    ) as PolicySelection;
  }

  const ownerAddresses = new Set(
    wallets
      .filter((w) => w.status === "ACTIVE" && w.chainKind === "evm" && w.proofKind === "siwe")
      .map((w) => w.address.toLowerCase()),
  );
  const owns = ownerAddresses.has(policy.owner.toLowerCase());
  if (!owns) {
    const linked = await deps.accounts.policiesFor(account.accountId);
    if (!linked.includes(policy.id)) {
      return refuse(
        "POLICY_REQUIRED",
        `policy ${policy.id} is owned on chain by ${policy.owner}, which is not a wallet this account has proven, ` +
          "and it is not delegated to this account either",
        [
          {
            field: "policyId",
            why: "neither ownership nor delegation connects this account to that policy",
            resolvedFrom: "use a policy your own wallet registered, or have the owner delegate this one",
          },
        ],
        "/consumer/policies",
      ) as PolicySelection;
    }
    return { ok: true, policy, derivedFrom: `${derivedFrom} (delegated to this account)` };
  }

  return { ok: true, policy, derivedFrom };
}

type RecipientResolution =
  | { readonly ok: true; readonly recipient: Address | null; readonly derivedFrom: string | null }
  | { readonly ok: false; readonly outcome: AuthorityOutcome };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Who receives the money.
 *
 * Three sources, in a fixed order, and a refusal rather than a fourth. The caller's own constraint
 * wins because constraining the recipient is the caller exercising authority, not asserting a fact.
 * The owned-service definition comes second because it is a published property of the service. There
 * is no third: a live quote supplies one, and until one has resolved the honest answer is that this
 * payment has no recipient yet.
 *
 * The address this host is itself paid at is not on the list, and the omission is the whole point. It
 * validates, it is the right shape, and a decision judged against it is a decision about a payment to
 * the wrong party.
 */
function resolveRecipient(
  request: AuthorityRequest,
  owned: OwnedServiceDefinition | null,
  record: <T extends string>(field: string, value: T, derivedFrom: string) => T,
): RecipientResolution {
  if (request.recipient !== undefined) {
    if (!ADDRESS.test(request.recipient)) {
      return {
        ok: false,
        outcome: refuse("RECIPIENT_REQUIRED", "recipient must be a 20-byte hex address", [
          { field: "recipient", why: "the value sent is not an address", resolvedFrom: "send a 0x-prefixed 20-byte address, or omit it" },
        ]),
      };
    }
    const value = request.recipient.toLowerCase() as Address;
    record("recipientAddress", value, "the recipient constraint you sent");
    return { ok: true, recipient: value, derivedFrom: "the recipient constraint you sent" };
  }

  if (owned?.recipient) {
    const from = owned.recipientDerivedFrom ?? `the registered payment address of service ${owned.serviceId}@${owned.version}`;
    record("recipientAddress", owned.recipient, from);
    return { ok: true, recipient: owned.recipient, derivedFrom: from };
  }

  return {
    ok: false,
    outcome: refuse(
      "RECIPIENT_REQUIRED",
      "who may be paid is not decided: you did not constrain a recipient, and no registered service " +
        "definition names a deterministic payment address for this capability. The address this host is " +
        "itself paid at is not the provider's, and judging a payment against it would judge the wrong payment",
      [
        {
          field: "recipientAddress",
          why: owned
            ? `service ${owned.serviceId}@${owned.version} is priced by live quote and has no fixed payment address`
            : `${request.provider}/${request.capability} is not a service this deployment performs itself, so no definition names its address`,
          resolvedFrom: "send `recipient`, or resolve a quote for this provider and capability first",
        },
      ],
    ),
  };
}

/**
 * The decision the engine returned, in the vocabulary the public contract publishes.
 *
 * The engine's own strings are richer — `ESCALATED_OVER_THRESHOLD` says which rule fired — and they
 * stay in `ruleTrace` untouched. What a caller branches on is this, and it has three values because a
 * fourth would be a state the approval machine cannot represent.
 */
export function publicOutcomeFor(engineDecision: string): "APPROVED_AUTOMATIC" | "ESCALATED" | "BLOCKED" {
  if (engineDecision === "APPROVED") return "APPROVED_AUTOMATIC";
  if (engineDecision.startsWith("ESCALATED")) return "ESCALATED";
  return "BLOCKED";
}

/** A hex the response can carry without a cast at every use. */
export function asHex(value: string): Hex {
  return value as Hex;
}
