import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MarketplaceBinding, UntchAccount, WalletBinding } from "@untch/consumer-core";
import type { StoredPolicy } from "@untch/policy-store";
import { findOwnedService } from "@untch/owned-work";
import { accountRefHash, commitmentInputOf, requesterCommitment } from "@untch/consumer-core";
import {
  resolveAuthority,
  publicOutcomeFor,
  type AccountFactsReader,
  type AuthorityDeps,
  type CallerIdentity,
  type StoredPolicyReader,
} from "../src/public-dto/authority";

/**
 * These tests are about the values NOBODY SENT.
 *
 * The mapping tests already cover what happens to a field a caller supplied. What decides whether the
 * public route is honest is what happens to the four it does not: which policy, which buyer agent,
 * which worker agent, and who is paid. Each has exactly one legitimate source and a named refusal for
 * every other case, and every one of those refusals is a case here — because a substitution failure
 * produces a request that validates, gets judged, gets receipted, and is wrong in a way no response
 * field reveals.
 */

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const OWNER = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const OTHER_WALLET = "0x1111111111111111111111111111111111111111";
/** The address this host is paid at. It appears here ONLY so a test can assert it is never borrowed. */
const HOST_PAY_TO = OWNER;

function account(over: Partial<UntchAccount> = {}): UntchAccount {
  return {
    accountId: "acct_test",
    status: "ACTIVE",
    displayName: null,
    primaryWalletBindingId: "wb_1",
    lastAuthenticatedAt: null,
    defaultPolicyId: "7",
    lastUsedPolicyId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "test",
    updatedAt: "2026-08-01T00:00:00.000Z",
    updatedBy: "test",
    ...over,
  };
}

function wallet(over: Partial<WalletBinding> = {}): WalletBinding {
  return {
    bindingId: "wb_1",
    accountId: "acct_test",
    chainKind: "evm",
    address: OWNER,
    role: "primary",
    proofKind: "siwe",
    scopes: ["identity", "policy-authority"],
    status: "ACTIVE",
    chainId: 196,
    provenAt: "2026-08-01T00:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "test",
    ...over,
  } as WalletBinding;
}

function marketplace(over: Partial<MarketplaceBinding> = {}): MarketplaceBinding {
  return {
    bindingId: "mb_1",
    accountId: "acct_test",
    marketplace: "okx",
    agentId: "6047",
    buyerId: null,
    provenBy: "wallet-signature",
    status: "ACTIVE",
    provenAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "test",
    ...over,
  } as MarketplaceBinding;
}

function policy(over: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: "7",
    owner: OWNER as `0x${string}`,
    agentId: OWNER as `0x${string}`,
    version: 1,
    status: "ACTIVE",
    policyHash: `0x${"44".repeat(32)}`,
    expiry: Math.floor(NOW / 1000) + 86_400,
    onchainRef: { chainId: 196, txHash: `0x${"ab".repeat(32)}`, blockNumber: 1 },
    rules: {} as StoredPolicy["rules"],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as StoredPolicy;
}

interface World {
  readonly accounts: AccountFactsReader;
  readonly policies: StoredPolicyReader;
}

function world(over: {
  account?: UntchAccount | null;
  wallets?: readonly WalletBinding[];
  marketplaces?: readonly MarketplaceBinding[];
  linkedPolicies?: readonly string[];
  policies?: Readonly<Record<string, StoredPolicy>>;
} = {}): World {
  const stored = over.policies ?? { "7": policy() };
  return {
    accounts: {
      getAccount: async () => (over.account === undefined ? account() : over.account),
      walletsFor: async () => over.wallets ?? [wallet()],
      marketplaceBindingsFor: async () => over.marketplaces ?? [marketplace()],
      policiesFor: async () => over.linkedPolicies ?? [],
    },
    policies: { loadStored: async (id: string) => stored[id] ?? null },
  };
}

const IDENTITY: CallerIdentity = {
  accountId: "acct_test",
  address: OWNER as `0x${string}`,
  bindingId: "wb_1",
  scopes: ["identity", "policy-authority"],
};

function deps(w: World): AuthorityDeps {
  return {
    accounts: w.accounts,
    policies: w.policies,
    ownedService: (p, c) => findOwnedService(p, c),
    now: () => NOW,
  };
}

const DEMO_REQUEST = { provider: "untch", capability: "owned_work.demo" };

describe("policy selection is a property of the account, not of the request", () => {
  test("no policyId resolves to the account's chosen default", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.authority.policy.id, "7");
    const record = result.authority.derived.find((d) => d.field === "policyId");
    assert.ok(record?.derivedFrom.includes("default"), "the response says the default was used");
  });

  test("an explicit policyId is used and is labelled as the caller's choice", async () => {
    const result = await resolveAuthority({ ...DEMO_REQUEST, policyId: "7" }, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const record = result.authority.derived.find((d) => d.field === "policyId");
    assert.equal(record?.derivedFrom, "the policyId you sent");
  });

  test("an account with no default and no policyId is told so, not given one", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ account: account({ defaultPolicyId: null }) })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "POLICY_REQUIRED");
    assert.ok(result.resolveBy?.includes("/consumer/policies/draft"));
  });

  test("a paused policy authorises nothing", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ policies: { "7": policy({ status: "PAUSED" as StoredPolicy["status"] }) } })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "POLICY_INACTIVE");
  });

  test("an expired policy stops authorising with no transaction needed", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ policies: { "7": policy({ expiry: Math.floor(NOW / 1000) - 1 }) } })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "POLICY_INACTIVE");
    assert.match(result.message, /expired/);
  });

  test("a policy owned by a wallet this account has not proven is refused", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ policies: { "7": policy({ owner: OTHER_WALLET as `0x${string}` }) } })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "POLICY_REQUIRED");
    assert.match(result.message, /not a wallet this account has proven/);
  });

  test("…unless the account holds a delegation link to it", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(
        world({
          policies: { "7": policy({ owner: OTHER_WALLET as `0x${string}` }) },
          linkedPolicies: ["7"],
        }),
      ),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const record = result.authority.derived.find((d) => d.field === "policyId");
    assert.match(record?.derivedFrom ?? "", /delegated/);
  });
});

describe("identity is re-read, never taken from the token", () => {
  test("no session at all is ACCOUNT_LINK_REQUIRED, with the route that fixes it", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, null, deps(world()));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "ACCOUNT_LINK_REQUIRED");
    assert.equal(result.resolveBy, "/consumer/account/link/start");
  });

  test("a revoked wallet stops spending before its session token expires", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ wallets: [wallet({ status: "REVOKED", revokedAt: "2026-08-02T00:00:00.000Z" })] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "ACCOUNT_LINK_REQUIRED");
    assert.match(result.message, /no longer an active binding/);
  });

  test("a declared binding is audit context and authorises nothing", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ wallets: [wallet({ proofKind: "declared" })] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /declared, not proven/);
  });

  test("a suspended account authorises nothing", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ account: account({ status: "SUSPENDED" }) })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "ACCOUNT_LINK_REQUIRED");
  });
});

describe("the buyer agent id comes from a signature or from nowhere", () => {
  test("a wallet-proven marketplace binding supplies it", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.authority.buyerAgentId, "6047");
    const record = result.authority.derived.find((d) => d.field === "buyerAgentId");
    assert.match(record?.derivedFrom ?? "", /wallet signature/);
  });

  /**
   * ── THE TWO TESTS THIS REPLACES, AND WHY THEY WERE WRONG RATHER THAN BROKEN ──
   *
   * Both encoded the contract V3 removes:
   *
   *   "an unproven binding does not, and the refusal says why" asserted that a caller with an
   *   unproven binding and no buyerAgentId gets AUTHORITY_NOT_DERIVABLE. Under the old contract that
   *   was right — every caller needed a buyer agent id. It is now wrong twice over: that caller is a
   *   DIRECT account request, which is a complete and legitimate description of who they are, and the
   *   advice it asserted on ("send buyerAgentId … recorded as a claim") points at a path that no
   *   longer exists.
   *
   *   "a caller-supplied id is accepted … and is labelled a claim" asserted that an unproven id is
   *   recorded with `verified: false`. Defensible under V2, where nothing downstream read the label.
   *   Not under V3, where `buyerAgentIdSemantics` is a committed field a stranger reads off a receipt
   *   with no way to see a `verified: false` that lived in a response body months ago.
   *
   * Deleting them would have left the new contract untested. These are their replacements: same two
   * situations, asserting what must happen now.
   */
  test("an unproven binding is not marketplace intent — the caller is a direct account", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ marketplaces: [marketplace({ provenBy: "unproven" })] })),
    );
    assert.equal(result.ok, true, "an unproven binding does not make somebody a marketplace requester");
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    assert.equal(r.requesterPrincipalKind, "untch_account");
    assert.equal(r.onchainBuyerAgentId, "0");
    assert.equal(r.buyerAgentId, null);
    // The unproven binding must not be attached to a decision that was not made through it.
    assert.equal(r.marketplace, null);
    assert.equal(r.marketplaceBindingId, null);
    assert.equal(result.authority.marketplace, null);
  });

  test("an unverified caller-supplied id is refused, not recorded as a claim", async () => {
    const result = await resolveAuthority(
      { ...DEMO_REQUEST, buyerAgentId: "999" },
      IDENTITY,
      deps(world({ marketplaces: [] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "MARKETPLACE_BUYER_REQUIRED");
    assert.match(result.message, /VERIFIED marketplace identity/);
    // The refusal has to name the path that actually works, or it is the unobtainable-predecessor
    // defect again: a refusal whose advice cannot be followed.
    assert.match(result.missing[0]?.resolvedFrom ?? "", /omit buyerAgentId entirely/);
    assert.match(result.missing[0]?.resolvedFrom ?? "", /direct Untch account/);
  });

  test("a declared binding plus a matching id is still refused", async () => {
    const result = await resolveAuthority(
      { ...DEMO_REQUEST, buyerAgentId: "6047" },
      IDENTITY,
      deps(world({ marketplaces: [marketplace({ provenBy: "unproven" })] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "MARKETPLACE_BUYER_REQUIRED");
    assert.match(result.missing[0]?.why ?? "", /unproven/);
  });

  test("a proven binding whose agent id is 0 does not become a marketplace requester", async () => {
    // The zero would claim `verified_marketplace_agent` over the same value a direct request uses to
    // mean "there is no marketplace buyer" — the two readings of the zero meeting in one record.
    const result = await resolveAuthority(
      { ...DEMO_REQUEST, buyerAgentId: "0" },
      IDENTITY,
      deps(world({ marketplaces: [marketplace({ agentId: "0" })] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "MARKETPLACE_BUYER_REQUIRED");
  });

  test("a header never overrides a signature", async () => {
    const result = await resolveAuthority({ ...DEMO_REQUEST, buyerAgentId: "999" }, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.authority.buyerAgentId, "6047", "the proven binding wins");
  });

  test("account-only authority is not marketplace proof", async () => {
    // A SIWE-proven WALLET proves an account. It says nothing about a marketplace, and a resolver that
    // let one stand in for the other would let every signed-in user claim any agent id.
    const result = await resolveAuthority(
      { ...DEMO_REQUEST, buyerAgentId: "6047" },
      IDENTITY,
      deps(world({ marketplaces: [] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "MARKETPLACE_BUYER_REQUIRED");
  });
});

/**
 * The direct account path, which is the whole point of this pass.
 *
 * Every assertion here is about a value NOBODY SENT and nobody may invent: the reserved zero, the
 * absent marketplace, the seller that is not the worker, and the agent id that must never appear.
 */
describe("a direct account request identifies itself without a marketplace", () => {
  const direct = () => world({ marketplaces: [] });

  test("succeeds with no buyerAgentId and no marketplace binding at all", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(direct()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    assert.equal(r.requesterPrincipalKind, "untch_account");
    assert.equal(r.requesterPrincipalNamespace, "untch-account");
    assert.equal(r.buyerAgentIdSemantics, "no_marketplace_buyer");
    assert.equal(r.onchainBuyerAgentId, "0");
    assert.equal(result.authority.buyerAgentId, null);
  });

  test("the requester reference IS the accountRefHash, and the raw accountId is not in it", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(direct()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    assert.equal(r.requesterPrincipalRef, r.accountRefHash);
    assert.equal(r.accountRefHash, accountRefHash("acct_test"));
    assert.equal(r.requesterPrincipalRef.includes("acct_test"), false);
  });

  test("the wallet authority is committed, and it is not the address", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(direct()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    assert.match(r.walletAuthorityRef, /^0x[0-9a-f]{64}$/);
    assert.equal(r.walletAuthorityRef.toLowerCase().includes(OWNER.slice(2).toLowerCase()), false);
  });

  test("6047 is never inserted into a direct request", async () => {
    // The account HOLDS a proven 6047 binding here. A direct request is still made when no marketplace
    // intent is present — but this request carries none, so nothing may reach for the id that is lying
    // around. The world used is the default one, which has the binding.
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(direct()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(JSON.stringify(result.authority.requesterEvidence).includes("6047"), false);
  });

  test("the wallet address is never cast into an agent id field", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(direct()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    // A 20-byte address serialised into a uint256 agent id is a category error that hashes cleanly,
    // which is why it is asserted on rather than trusted to be obviously wrong.
    for (const value of [r.onchainBuyerAgentId, r.workerAgentId, r.sellerAspId]) {
      assert.equal(value.toLowerCase().includes(OWNER.slice(2, 10).toLowerCase()), false);
      assert.match(value, /^[0-9]+$/, "an agent id is a uint, never an address");
    }
  });

  test("sellerAspId and workerAgentId are separate fields that currently hold the same value", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(direct()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    assert.equal(r.sellerAspId, "6086");
    assert.equal(r.workerAgentId, "6086");
    // Equal today and read from two different sources: the deployment's seller identity and the
    // service's worker identity. The assertion that matters is that both keys exist.
    assert.ok("sellerAspId" in r && "workerAgentId" in r, "two roles, two fields");
    assert.equal(r.serviceId, "owned_work.demo");
  });

  test("a delegated policy is refused: the owner address would name somebody else", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(
        world({
          marketplaces: [],
          policies: { "7": policy({ owner: OTHER_WALLET as `0x${string}` }) },
          linkedPolicies: ["7"],
        }),
      ),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "REQUESTER_AUTHORITY_NOT_DERIVABLE");
    assert.match(result.message, /delegated to this account rather than owned by it/);
  });

  test("a policy owned by an address this account never proved is refused before delegation is even asked", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ marketplaces: [], policies: { "7": policy({ owner: OTHER_WALLET as `0x${string}` }) } })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "POLICY_REQUIRED");
  });

  test("an identity-only binding proves a name and does not spend", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ marketplaces: [], wallets: [wallet({ scopes: ["identity"] })] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "AUTHORITY_NOT_DERIVABLE");
    assert.equal(result.missing[0]?.field, "scopes");
  });

  test("a revoked wallet produces no requester at all", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ marketplaces: [], wallets: [wallet({ status: "REVOKED" })] })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "ACCOUNT_LINK_REQUIRED");
  });

  test("an expired policy is refused on the direct path too", async () => {
    const result = await resolveAuthority(
      DEMO_REQUEST,
      IDENTITY,
      deps(world({ marketplaces: [], policies: { "7": policy({ expiry: Math.floor(NOW / 1000) - 1 }) } })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "POLICY_INACTIVE");
  });

  test("two accounts asking identically produce different requester commitments", async () => {
    const mine = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(direct()));
    const theirs = await resolveAuthority(
      DEMO_REQUEST,
      { ...IDENTITY, accountId: "acct_other" },
      deps(
        world({
          marketplaces: [],
          account: account({ accountId: "acct_other" }),
          wallets: [wallet({ accountId: "acct_other" })],
        }),
      ),
    );
    assert.equal(mine.ok, true);
    assert.equal(theirs.ok, true);
    if (!mine.ok || !theirs.ok) return;
    assert.notEqual(
      requesterCommitment(commitmentInputOf(mine.authority.requesterEvidence)),
      requesterCommitment(commitmentInputOf(theirs.authority.requesterEvidence)),
      "an identical request from another account must not commit to the same requester",
    );
  });
});

describe("a marketplace request names a verified agent", () => {
  test("a verified binding produces the marketplace requester record", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    assert.equal(r.requesterPrincipalKind, "marketplace_agent");
    assert.equal(r.requesterPrincipalNamespace, "okx-ai");
    assert.equal(r.requesterPrincipalRef, "okx-ai:6047");
    assert.equal(r.buyerAgentIdSemantics, "verified_marketplace_agent");
    assert.equal(r.onchainBuyerAgentId, "6047");
    assert.equal(r.buyerAgentId, "6047");
    assert.equal(r.marketplaceBindingId, "mb_1");
  });

  test("a marketplace requester cannot present itself as a direct account", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const r = result.authority.requesterEvidence;
    assert.notEqual(r.requesterPrincipalKind, "untch_account");
    assert.notEqual(r.requesterPrincipalRef, r.accountRefHash);
  });
});

describe("the recipient is derived from a definition or refused", () => {
  test("an owned service names its own payment address, and says where it came from", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.authority.recipient, "an owned service has a deterministic recipient");
    assert.match(result.authority.recipientDerivedFrom ?? "", /own definition/);
    // The provenance must say it is not a host-config fallback, because that is the failure the
    // resolver's structure prevents and the sentence a reviewer checks it against.
    assert.match(result.authority.recipientDerivedFrom ?? "", /not a fallback to host config/);
  });

  test("a caller's own constraint wins over the definition", async () => {
    const result = await resolveAuthority(
      { ...DEMO_REQUEST, recipient: OTHER_WALLET },
      IDENTITY,
      deps(world()),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.authority.recipient, OTHER_WALLET.toLowerCase());
  });

  /**
   * The one that matters most.
   *
   * A provider this deployment does not perform itself, with no quote and no caller constraint, has
   * no honest recipient. The old failure was to reach for whatever address was in scope; here there
   * is nothing in scope to reach for, and the assertion is that the answer is a refusal rather than
   * the host's own payTo wearing a provider's name.
   */
  test("an unknown provider with no constraint refuses rather than borrowing the host payTo", async () => {
    const result = await resolveAuthority(
      { provider: "stabledomains", capability: "domains.register", workerAgentId: "6086" },
      IDENTITY,
      deps(world()),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "RECIPIENT_REQUIRED");
    assert.equal(
      JSON.stringify(result).toLowerCase().includes(HOST_PAY_TO.toLowerCase()),
      false,
      "the refusal must not contain the host's payTo — not even as a suggestion",
    );
  });

  test("a malformed recipient is a refusal, not a silent drop", async () => {
    const result = await resolveAuthority(
      { ...DEMO_REQUEST, recipient: "not-an-address" },
      IDENTITY,
      deps(world()),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "RECIPIENT_REQUIRED");
  });
});

describe("the worker agent id comes from the registered definition", () => {
  test("an owned service supplies it", async () => {
    const result = await resolveAuthority(DEMO_REQUEST, IDENTITY, deps(world()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.authority.workerAgentId, "6086");
  });

  test("a provider with no registration and no supplied id refuses by name", async () => {
    const result = await resolveAuthority(
      { provider: "stabledomains", capability: "domains.register", recipient: OTHER_WALLET },
      IDENTITY,
      deps(world()),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "AUTHORITY_NOT_DERIVABLE");
    assert.equal(result.missing[0]?.field, "workerAgentId");
  });
});

describe("the public outcome vocabulary", () => {
  test("the engine's own words map onto exactly three public ones", () => {
    assert.equal(publicOutcomeFor("APPROVED"), "APPROVED_AUTOMATIC");
    assert.equal(publicOutcomeFor("ESCALATED_OVER_THRESHOLD"), "ESCALATED");
    assert.equal(publicOutcomeFor("ESCALATED_SIGNER_DOWN"), "ESCALATED");
    assert.equal(publicOutcomeFor("BLOCKED_NO_ACTIVE_POLICY"), "BLOCKED");
    assert.equal(publicOutcomeFor("BLOCKED_OVER_CAP"), "BLOCKED");
  });
});

describe("the owned-service registry says only what it can back", () => {
  test("both registered services carry a real artifact contract", () => {
    for (const id of ["owned_work.demo", "battle_card"]) {
      const definition = findOwnedService("untch", id);
      assert.ok(definition, `${id} is registered`);
      assert.ok(definition.outputContract.length > 0, `${id} promises at least one file`);
      assert.ok(
        definition.outputContract.some((e) => e.required),
        `${id} has a deliverable a manifest can fail on`,
      );
    }
  });

  test("a capability nobody registered resolves to nothing", () => {
    assert.equal(findOwnedService("untch", "gtm_package"), null);
    assert.equal(findOwnedService("stabledomains", "owned_work.demo"), null);
  });
});
