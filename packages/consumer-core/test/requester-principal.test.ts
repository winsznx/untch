import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keccak256, toHex, type Hex } from "viem";
import {
  metadataHashV2,
  DIRECT_ACCOUNT_ONCHAIN_BUYER_AGENT_ID,
  LEGACY_AGENT_ID_SEMANTICS_V3,
  LEGACY_ZERO_AGENT_ID_BYTES32,
  METADATA_SCHEMA_VERSION_V3,
  NEVER_PUBLIC_FIELDS,
  POLICY_SELECTION_SEMANTICS,
  RequesterEvidenceError,
  accountRefHash,
  approvalDigest,
  assembleDecisionEvidenceV3,
  assertRequesterEvidenceV3,
  commitmentInputOf,
  isV3Evidence,
  metadataHashV3,
  metadataV3Of,
  presentRequester,
  privateDecisionProjectionV3,
  projectionReportV3,
  publicDecisionProjectionV3,
  publicFromRow,
  quoteDigestOfV3,
  rawLegacyAgentProjection,
  requesterCommitment,
  verifyMetadataCommitment,
  verifyReceiptRequester,
  walletAuthorityRef,
  type ApprovalSubject,
  type AssembledEvidenceV3,
  type CanonicalQuoteTermsV3,
  type DecisionEvidenceV3,
  type MetadataV2,
  type MetadataV3,
  type PolicySnapshot,
  type RequesterEvidenceV3,
} from "../src/index";

/**
 * WHAT THESE TESTS ARE ABOUT
 *
 * One value — `buyerAgentId = 0` — means "no marketplace buyer" under V3 and "a decision receipted
 * against an agent that does not exist" under V1 and V2. Everything below exists because those two
 * readings must never be able to reach each other: not through a commitment that ignores the
 * requester, not through a verifier that reads the bytes without the schema, and not through a
 * projection that renders the number as a name.
 */

const H = (b: string): Hex => `0x${b.repeat(32)}` as Hex;
const ACCOUNT = "acct_test";
const OWNER = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const AGENT = "0x1111111111111111111111111111111111111111";
const EVALUATED_AT = "2026-08-03T12:00:00.000Z";

const AUTHORITY = walletAuthorityRef({
  chainKind: "evm",
  address: OWNER,
  walletBindingId: "wb_1",
  proofKind: "siwe",
  verifiedAt: "2026-08-01T00:00:00.000Z",
});

function directRequester(over: Partial<RequesterEvidenceV3> = {}): RequesterEvidenceV3 {
  return {
    requesterPrincipalKind: "untch_account",
    requesterPrincipalNamespace: "untch-account",
    requesterPrincipalRef: accountRefHash(ACCOUNT),
    accountRefHash: accountRefHash(ACCOUNT),
    walletAuthorityRef: AUTHORITY,
    onchainBuyerAgentId: "0",
    buyerAgentIdSemantics: "no_marketplace_buyer",
    buyerAgentId: null,
    marketplace: null,
    marketplaceBindingId: null,
    sellerAspId: "6086",
    workerAgentId: "6086",
    serviceId: "owned_work.demo",
    ...over,
  };
}

function marketplaceRequester(over: Partial<RequesterEvidenceV3> = {}): RequesterEvidenceV3 {
  return {
    requesterPrincipalKind: "marketplace_agent",
    requesterPrincipalNamespace: "okx-ai",
    requesterPrincipalRef: "okx-ai:6047",
    accountRefHash: accountRefHash(ACCOUNT),
    walletAuthorityRef: AUTHORITY,
    onchainBuyerAgentId: "6047",
    buyerAgentIdSemantics: "verified_marketplace_agent",
    buyerAgentId: "6047",
    marketplace: "okx",
    marketplaceBindingId: "mb_1",
    sellerAspId: "6086",
    workerAgentId: "6086",
    serviceId: "owned_work.demo",
    ...over,
  };
}

function snapshot(over: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    policyId: "7",
    policyHash: H("44"),
    owner: OWNER,
    governedAgent: AGENT,
    chainId: 196,
    registry: "0xregistry",
    currency: "USDT0",
    rules: { perCall: { max: "10.00" } },
    version: 1,
    expiryAtEval: "2027-01-01T00:00:00.000Z",
    statusAtEval: "ACTIVE",
    activeAtEval: true,
    defaultForAccount: true,
    ...over,
  };
}

function quoteTerms(r: RequesterEvidenceV3, over: Partial<CanonicalQuoteTermsV3> = {}): CanonicalQuoteTermsV3 {
  return {
    quoteSchemaVersion: 3,
    lineage: "lin_1",
    version: 1,
    requesterPrincipalKind: r.requesterPrincipalKind,
    requesterPrincipalNamespace: r.requesterPrincipalNamespace,
    requesterPrincipalRef: r.requesterPrincipalRef,
    accountRefHash: r.accountRefHash,
    walletAuthorityRef: r.walletAuthorityRef,
    marketplace:
      r.marketplace !== null && r.buyerAgentId !== null && r.marketplaceBindingId !== null
        ? { marketplace: r.marketplace, buyerAgentId: r.buyerAgentId, marketplaceBindingId: r.marketplaceBindingId }
        : null,
    sellerAspId: r.sellerAspId,
    workerAgentId: r.workerAgentId,
    serviceId: r.serviceId,
    policyId: "7",
    policyHash: H("44"),
    policyOwner: OWNER,
    governedAgent: AGENT,
    amount: "6.00",
    asset: "USDT0",
    chain: "eip155:196",
    recipient: OWNER,
    provider: "untch",
    capability: "owned_work.demo",
    paramsHash: H("aa"),
    acceptanceHash: H("bb"),
    expiry: "2026-08-04T00:00:00.000Z",
    nonce: "12345",
    ...over,
  };
}

function assemble(
  r: RequesterEvidenceV3 = directRequester(),
  terms: CanonicalQuoteTermsV3 = quoteTerms(r),
): AssembledEvidenceV3 {
  return assembleDecisionEvidenceV3({
    decisionId: "dec_1",
    intentId: "int_1",
    intentHash: H("11"),
    accountId: ACCOUNT,
    walletBindingId: "wb_1",
    requester: r,
    policyId: "7",
    policyHash: H("44"),
    policyOwner: OWNER,
    governedAgent: AGENT,
    snapshot: snapshot(),
    quoteTerms: terms,
    engineVersion: "policy-engine@1.4.0",
    ruleManifestHash: H("cc"),
    decision: "APPROVED",
    ruleTrace: [{ rule: "perCall", outcome: "pass" }],
    evaluatedAt: EVALUATED_AT,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("walletAuthorityRef binds the authority state, not the address", () => {
  const base = {
    chainKind: "evm",
    address: OWNER,
    walletBindingId: "wb_1",
    proofKind: "siwe",
    verifiedAt: "2026-08-01T00:00:00.000Z",
  };

  test("it is a domain-separated 32-byte hash and does not contain the address", () => {
    const ref = walletAuthorityRef(base);
    assert.match(ref, /^0x[0-9a-f]{64}$/);
    assert.equal(ref.toLowerCase().includes(OWNER.slice(2).toLowerCase()), false);
  });

  test("checksum case is display and must not fork the hash", () => {
    assert.equal(walletAuthorityRef({ ...base, address: OWNER.toUpperCase().replace("0X", "0x") }), walletAuthorityRef(base));
  });

  for (const [field, changed] of [
    ["address", { address: AGENT }],
    ["walletBindingId", { walletBindingId: "wb_2" }],
    ["proofKind", { proofKind: "declared" }],
    ["chainKind", { chainKind: "solana" }],
    ["verifiedAt", { verifiedAt: "2026-08-02T00:00:00.000Z" }],
  ] as const) {
    test(`changing ${field} changes the authority`, () => {
      assert.notEqual(walletAuthorityRef({ ...base, ...changed }), walletAuthorityRef(base));
    });
  }

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * A revoked binding is never deleted (migration 024) and the address is never freed, so the only
   * way back is reactivation on the SAME account — which writes a fresh proof at a fresh time. If the
   * authority ref did not move, an approval created before the revocation would still match
   * afterwards, and revoking a compromised wallet would not invalidate what it had already been shown.
   */
  test("reactivation after revocation produces a different authority", () => {
    const before = walletAuthorityRef(base);
    const afterReactivation = walletAuthorityRef({
      ...base,
      proofKind: "siwe",
      verifiedAt: "2026-09-01T00:00:00.000Z",
    });
    assert.notEqual(afterReactivation, before);
  });

  test("null and undefined verifiedAt are not silently the same fact", () => {
    // `undefined` is dropped by RFC 8785 and `null` is encoded. Both are passed as null by the
    // resolver precisely so this can never be a source of two hashes for one binding.
    assert.notEqual(walletAuthorityRef({ ...base, verifiedAt: null }), walletAuthorityRef(base));
  });
});

describe("the requester commitment", () => {
  test("a direct account's reference IS its accountRefHash and never its raw id", () => {
    const r = directRequester();
    assert.equal(r.requesterPrincipalRef, accountRefHash(ACCOUNT));
    assert.equal(requesterCommitment(commitmentInputOf(r)).includes(ACCOUNT), false);
  });

  for (const [what, over] of [
    ["accountRefHash", { accountRefHash: accountRefHash("acct_other"), requesterPrincipalRef: accountRefHash("acct_other") }],
    ["walletAuthorityRef", { walletAuthorityRef: H("99") }],
  ] as const) {
    test(`changing ${what} changes the requester commitment`, () => {
      assert.notEqual(
        requesterCommitment(commitmentInputOf(directRequester(over))),
        requesterCommitment(commitmentInputOf(directRequester())),
      );
    });
  }

  test("changing the requester kind changes the commitment", () => {
    assert.notEqual(
      requesterCommitment(commitmentInputOf(marketplaceRequester())),
      requesterCommitment(commitmentInputOf(directRequester())),
    );
  });

  test("the namespace is inside the hash, so one id in two registries does not collide", () => {
    const okx = requesterCommitment(commitmentInputOf(marketplaceRequester()));
    const other = requesterCommitment(
      commitmentInputOf(marketplaceRequester({ requesterPrincipalNamespace: "other-ai", requesterPrincipalRef: "other-ai:6047" })),
    );
    assert.notEqual(okx, other);
  });
});

describe("the requester record refuses shapes that cannot exist", () => {
  const cases: readonly (readonly [string, RequesterEvidenceV3, RegExp])[] = [
    ["a direct request with a nonzero buyerAgentId", directRequester({ onchainBuyerAgentId: "6047" }), /reserves buyerAgentId 0/],
    ["a direct request carrying a marketplace", directRequester({ marketplace: "okx" }), /names no marketplace/],
    ["a direct request carrying a binding id", directRequester({ marketplaceBindingId: "mb_1" }), /no marketplace binding/],
    ["a direct request carrying a buyer agent id", directRequester({ buyerAgentId: "6047" }), /no marketplace buyer agent id/],
    ["a direct request in the wrong namespace", directRequester({ requesterPrincipalNamespace: "okx-ai" }), /namespaced untch-account/],
    ["a direct request whose ref is not its accountRefHash", directRequester({ requesterPrincipalRef: H("77") }), /IS its accountRefHash/],
    ["a direct request claiming marketplace semantics", directRequester({ buyerAgentIdSemantics: "verified_marketplace_agent" }), /no_marketplace_buyer/],
    ["a marketplace request with a zero id", marketplaceRequester({ onchainBuyerAgentId: "0", buyerAgentId: "0", requesterPrincipalRef: "okx-ai:0" }), /greater than zero/],
    ["a marketplace request with no binding", marketplaceRequester({ marketplaceBindingId: null }), /VERIFIED binding/],
    ["a marketplace request claiming direct semantics", marketplaceRequester({ buyerAgentIdSemantics: "no_marketplace_buyer" }), /verified_marketplace_agent/],
    ["a marketplace request whose on-chain id disagrees", marketplaceRequester({ onchainBuyerAgentId: "6048" }), /must equal the verified/],
  ];

  for (const [name, record, expected] of cases) {
    test(`${name} is refused`, () => {
      assert.throws(() => assertRequesterEvidenceV3(record), (err: unknown) => {
        assert.ok(err instanceof RequesterEvidenceError);
        assert.match(err.message, expected);
        return true;
      });
    });
  }

  test("both legitimate shapes are accepted", () => {
    assert.doesNotThrow(() => assertRequesterEvidenceV3(directRequester()));
    assert.doesNotThrow(() => assertRequesterEvidenceV3(marketplaceRequester()));
  });
});

describe("the quote digest binds the requester and the exact policy", () => {
  const base = quoteTerms(directRequester());

  for (const [what, over] of [
    ["accountRefHash", { accountRefHash: accountRefHash("acct_other") }],
    ["walletAuthorityRef", { walletAuthorityRef: H("99") }],
    ["requesterPrincipalKind", { requesterPrincipalKind: "marketplace_agent" }],
    ["requesterPrincipalRef", { requesterPrincipalRef: "okx-ai:6047" }],
    ["policyId", { policyId: "8" }],
    ["sellerAspId", { sellerAspId: "9999" }],
    ["workerAgentId", { workerAgentId: "9999" }],
    ["amount", { amount: "6.50" }],
  ] as const) {
    test(`changing ${what} changes the quote digest`, () => {
      assert.notEqual(quoteDigestOfV3({ ...base, ...over }), quoteDigestOfV3(base));
    });
  }

  /**
   * The failure the whole design is for: without the requester in the digest, this pair would be
   * equal, and an approval one account obtained would match the other's request byte for byte.
   */
  test("an otherwise identical request from another account produces a different digest", () => {
    const other = directRequester({
      accountRefHash: accountRefHash("acct_other"),
      requesterPrincipalRef: accountRefHash("acct_other"),
    });
    assert.notEqual(quoteDigestOfV3(quoteTerms(other)), quoteDigestOfV3(base));
  });

  test("two policies with the same owner and ruleset still produce different digests", () => {
    // The on-chain hash cannot tell these apart. The digest is where the difference survives.
    assert.notEqual(quoteDigestOfV3({ ...base, policyId: "8" }), quoteDigestOfV3(base));
  });

  test("the evaluator's digest is the one persisted, not one rebuilt from display fields", () => {
    const a = assemble();
    assert.equal(a.evidence.quoteDigest, quoteDigestOfV3(a.quoteTerms));
  });
});

describe("the approval digest binds the requester", () => {
  const subject = (over: Partial<ApprovalSubject> = {}): ApprovalSubject => ({
    intentId: "int_1",
    quoteHash: H("aa"),
    amount: "6.00",
    asset: "USDT0",
    provider: "untch",
    capability: "owned_work.demo",
    recipient: OWNER,
    policyId: "7",
    policyVersion: 1,
    nonce: "12345",
    expiresAt: "2026-08-04T00:00:00.000Z",
    ...over,
  });

  const requesterOf = (r: RequesterEvidenceV3, quoteDigest = H("dd")) => ({
    requesterPrincipalKind: r.requesterPrincipalKind,
    requesterPrincipalNamespace: r.requesterPrincipalNamespace,
    requesterPrincipalRef: r.requesterPrincipalRef,
    accountRefHash: r.accountRefHash,
    walletAuthorityRef: r.walletAuthorityRef,
    quoteDigest,
  });

  /**
   * The compatibility test, and it is not decoration.
   *
   * Approvals raised before V3 are sitting PENDING in production with digests computed over twelve
   * fields. If widening the encoding changed them, the next person to tap Approve on yesterday's
   * decision would get DIGEST_MISMATCH for a payment nothing about which had changed.
   */
  test("a subject with no requester hashes exactly as it did before V3", () => {
    // A frozen literal, computed from the pre-V3 encoding, because that is the only form of this
    // assertion that can fail. Recomputing it with the current code would prove nothing: it would
    // agree with whatever the code now does, which is precisely the thing under test.
    assert.equal(
      approvalDigest(subject()),
      "apd_6ff706a8937e29e20923e1e6aec2e3cf95df4ba762cf6f313ad67b071b4bc5a5",
      "a pre-V3 approval must keep its digest, or every PENDING request in production breaks",
    );
  });

  test("adding a requester produces a different, v=2 digest", () => {
    assert.notEqual(approvalDigest(subject()), approvalDigest(subject({ requester: requesterOf(directRequester()) })));
  });

  test("account A's approval cannot authorize account B", () => {
    const other = directRequester({
      accountRefHash: accountRefHash("acct_other"),
      requesterPrincipalRef: accountRefHash("acct_other"),
    });
    assert.notEqual(
      approvalDigest(subject({ requester: requesterOf(other) })),
      approvalDigest(subject({ requester: requesterOf(directRequester()) })),
    );
  });

  test("an approval created before revocation cannot survive reactivation", () => {
    const before = requesterOf(directRequester());
    const afterReactivation = requesterOf(
      directRequester({
        walletAuthorityRef: walletAuthorityRef({
          chainKind: "evm",
          address: OWNER,
          walletBindingId: "wb_1",
          proofKind: "siwe",
          verifiedAt: "2026-09-01T00:00:00.000Z",
        }),
      }),
    );
    assert.notEqual(approvalDigest(subject({ requester: afterReactivation })), approvalDigest(subject({ requester: before })));
  });

  test("a direct approval cannot authorize a marketplace request, and the reverse", () => {
    const direct = approvalDigest(subject({ requester: requesterOf(directRequester()) }));
    const market = approvalDigest(subject({ requester: requesterOf(marketplaceRequester()) }));
    assert.notEqual(direct, market);
  });

  test("a 6.00 approval cannot authorize a 6.50 quote", () => {
    const r = requesterOf(directRequester());
    assert.notEqual(approvalDigest(subject({ amount: "6.50", requester: r })), approvalDigest(subject({ requester: r })));
  });

  test("a policy-ID change invalidates the approval even when the ruleset hash is identical", () => {
    const r = requesterOf(directRequester());
    assert.notEqual(approvalDigest(subject({ policyId: "8", requester: r })), approvalDigest(subject({ requester: r })));
  });

  test("a different quoteDigest is a different approval", () => {
    assert.notEqual(
      approvalDigest(subject({ requester: requesterOf(directRequester(), H("ee")) })),
      approvalDigest(subject({ requester: requesterOf(directRequester(), H("dd")) })),
    );
  });
});

describe("V3 evidence assembly", () => {
  test("a complete direct decision assembles and is V3_COMPLETE", () => {
    const a = assemble();
    assert.equal(a.evidence.metadataSchemaVersion, METADATA_SCHEMA_VERSION_V3);
    assert.equal(a.evidence.completeness, "V3_COMPLETE");
    assert.equal(a.evidence.policySelectionSemantics, POLICY_SELECTION_SEMANTICS);
    assert.equal(a.evidence.onchainBuyerAgentId, DIRECT_ACCOUNT_ONCHAIN_BUYER_AGENT_ID);
    assert.equal(isV3Evidence(a.evidence), true);
  });

  test("a quote priced for another requester is refused, not hashed", () => {
    const other = directRequester({
      accountRefHash: accountRefHash("acct_other"),
      requesterPrincipalRef: accountRefHash("acct_other"),
    });
    assert.throws(
      () => assemble(directRequester(), quoteTerms(other)),
      /priced for requester .* but the decision names/,
    );
  });

  test("a quote naming another policy is refused", () => {
    assert.throws(() => assemble(directRequester(), quoteTerms(directRequester(), { policyId: "8" })), /names policy 8/);
  });

  test("a snapshot of a different policy is refused", () => {
    assert.throws(
      () =>
        assembleDecisionEvidenceV3({
          decisionId: "dec_1",
          intentId: "int_1",
          intentHash: H("11"),
          accountId: ACCOUNT,
          walletBindingId: "wb_1",
          requester: directRequester(),
          policyId: "7",
          policyHash: H("44"),
          policyOwner: OWNER,
          governedAgent: AGENT,
          snapshot: snapshot({ policyId: "8" }),
          quoteTerms: quoteTerms(directRequester()),
          engineVersion: "e",
          ruleManifestHash: H("cc"),
          decision: "APPROVED",
          ruleTrace: [],
          evaluatedAt: EVALUATED_AT,
        }),
      /snapshot is of policy 8/,
    );
  });

  test("an impossible requester is refused at assembly, before any hash exists", () => {
    assert.throws(
      () => assemble(directRequester({ onchainBuyerAgentId: "6047" })),
      (err: unknown) => err instanceof RequesterEvidenceError,
    );
  });

  test("the policy owner and governed agent are lowercased into the commitment", () => {
    const a = assemble();
    assert.equal(a.evidence.policyOwner, OWNER.toLowerCase());
    assert.equal(a.evidence.governedAgent, AGENT.toLowerCase());
  });
});

describe("the V3 metadata commitment", () => {
  test("it verifies against itself", () => {
    const a = assemble();
    assert.equal(verifyMetadataCommitment({ committed: a.metadataHash, version: 3, v3: a.metadata }).ok, true);
  });

  test("changing any committed field fails verification", () => {
    const a = assemble();
    const tamperings: Partial<Record<keyof typeof a.metadata, unknown>>[] = [
      { requesterPrincipalKind: "marketplace_agent" },
      { requesterPrincipalNamespace: "okx-ai" },
      { requesterPrincipalRef: accountRefHash("acct_other") },
      { accountRefHash: accountRefHash("acct_other") },
      { walletAuthorityRef: H("99") },
      { onchainBuyerAgentId: "6047" },
      { buyerAgentIdSemantics: "verified_marketplace_agent" },
      { sellerAspId: "1" },
      { workerAgentId: "1" },
      { serviceId: "battle_card" },
      { policyId: "8" },
      { policyHash: H("55") },
      { policyOwner: AGENT },
      { governedAgent: OWNER },
      { policySnapshotHash: H("66") },
      { policySelectionSemantics: "something_else" },
      { quoteDigest: H("77") },
      { intentHash: H("88") },
      { engineVersion: "policy-engine@9.9.9" },
      { ruleManifestHash: H("aa") },
      { decision: "BLOCKED_PER_CALL_CAP" },
      { evaluatedAt: "2026-08-03T12:00:01.000Z" },
    ];
    for (const t of tamperings) {
      const tampered = { ...a.metadata, ...t } as MetadataV3;
      assert.equal(
        verifyMetadataCommitment({ committed: a.metadataHash, version: 3, v3: tampered }).ok,
        false,
        `tampering with ${Object.keys(t)[0]} must fail verification`,
      );
    }
  });

  test("a V3 commitment without the V3 object is refused rather than assumed", () => {
    assert.equal(verifyMetadataCommitment({ committed: H("11"), version: 3 }).ok, false);
  });

  test("the commitment does not depend on JSON key order", () => {
    const a = assemble();
    const reordered = Object.fromEntries(Object.entries(a.metadata).reverse()) as unknown as MetadataV3;
    assert.equal(metadataHashV3(reordered), a.metadataHash);
  });
});

describe("the receipt verifier reads the schema, never the bytes alone", () => {
  const v3 = (over: Partial<RequesterEvidenceV3> = {}): { e: DecisionEvidenceV3; hash: Hex } => {
    const a = assemble(directRequester(over));
    return { e: a.evidence, hash: a.metadataHash };
  };

  test("a V3 direct receipt with a zero agentId verifies, and says what the zero means", () => {
    const { e, hash } = v3();
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: LEGACY_ZERO_AGENT_ID_BYTES32,
      version: 3,
      committedMetadataHash: hash,
      v3: e,
      provenPolicyOwner: OWNER,
    });
    assert.deepEqual(r.refusals, []);
    assert.equal(r.ok, true);
    assert.equal(r.legacyAgentIdSemantics, LEGACY_AGENT_ID_SEMANTICS_V3);
  });

  test("a V3 marketplace receipt verifies only with a VERIFIED binding", () => {
    const a = assemble(marketplaceRequester());
    const anchored = `0x${(6047).toString(16).padStart(64, "0")}` as Hex;
    const withProof = verifyReceiptRequester({
      legacyAgentIdBytes32: anchored,
      version: 3,
      committedMetadataHash: a.metadataHash,
      v3: a.evidence,
      marketplaceBindingVerified: true,
    });
    assert.deepEqual(withProof.refusals, []);
    assert.equal(withProof.ok, true);

    const unchecked = verifyReceiptRequester({
      legacyAgentIdBytes32: anchored,
      version: 3,
      committedMetadataHash: a.metadataHash,
      v3: a.evidence,
    });
    assert.equal(unchecked.ok, false);
    assert.match(unchecked.refusals.join(" "), /VERIFIED marketplace binding/);
  });

  test("a V3 direct receipt anchored under a nonzero agentId is refused", () => {
    const { e, hash } = v3();
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: `0x${(6047).toString(16).padStart(64, "0")}` as Hex,
      version: 3,
      committedMetadataHash: hash,
      v3: e,
    });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join(" "), /reserves agentId 0/);
  });

  test("a V3 marketplace receipt anchored under zero is refused", () => {
    const a = assemble(marketplaceRequester());
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: LEGACY_ZERO_AGENT_ID_BYTES32,
      version: 3,
      committedMetadataHash: a.metadataHash,
      v3: a.evidence,
      marketplaceBindingVerified: true,
    });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join(" "), /zero names no agent/);
  });

  /**
   * THE RETROACTIVITY TEST.
   *
   * A V1 or V2 receipt with a zero agentId was invalid when it was written. It does not become valid
   * because a later schema gave the same bytes a legitimate meaning.
   */
  test("a V1 receipt with a zero agentId does NOT get the V3 reading", () => {
    const v1Object = { intentHash: H("11"), decision: "APPROVED", evaluatedAt: EVALUATED_AT };
    const v1Hash = (value: unknown): Hex => keccak256(toHex(JSON.stringify(value)));
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: LEGACY_ZERO_AGENT_ID_BYTES32,
      version: 1,
      // A CORRECT commitment, so the only possible refusal is the zero-agentId rule. A wrong hash
      // here would let a commitment failure masquerade as the retroactivity check passing.
      committedMetadataHash: v1Hash(v1Object),
      v1Object,
      v1Hash,
    });
    assert.equal(r.ok, false);
    assert.equal(r.refusals.length, 1);
    assert.match(r.refusals[0] as string, /not applied\s+retroactively/);
    assert.equal(r.legacyAgentIdSemantics, null);
  });

  const V2_METADATA: MetadataV2 = {
    metadataSchemaVersion: 2,
    accountRefHash: accountRefHash(ACCOUNT),
    quoteDigest: H("dd"),
    policySnapshotHash: H("ee"),
    policyHash: H("44"),
    engineVersion: "policy-engine@1.4.0",
    ruleManifestHash: H("cc"),
    intentHash: H("11"),
    decision: "APPROVED",
    evaluatedAt: EVALUATED_AT,
  };
  const V2_COMMITMENT = metadataHashV2(V2_METADATA);

  test("a V2 receipt with a zero agentId does NOT get the V3 reading", () => {
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: LEGACY_ZERO_AGENT_ID_BYTES32,
      version: 2,
      committedMetadataHash: V2_COMMITMENT,
      v2: V2_METADATA,
    });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join(" "), /V2, where a zero agentId/);
    assert.equal(r.legacyAgentIdSemantics, null);
  });

  test("a V2 receipt with a real agent id verifies under V2 rules, unchanged", () => {
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: `0x${(6047).toString(16).padStart(64, "0")}` as Hex,
      version: 2,
      committedMetadataHash: V2_COMMITMENT,
      v2: V2_METADATA,
    });
    assert.deepEqual(r.refusals, []);
    assert.equal(r.ok, true);
  });

  test("a V1 receipt with a real agent id verifies under V1 rules, unchanged", () => {
    const v1Object = { intentHash: H("11"), decision: "APPROVED", evaluatedAt: EVALUATED_AT };
    // V1's own algorithm, kept because changing it would un-verify every receipt already anchored.
    const v1Hash = (value: unknown): Hex => keccak256(toHex(JSON.stringify(value)));
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: `0x${(6047).toString(16).padStart(64, "0")}` as Hex,
      version: 1,
      committedMetadataHash: v1Hash(v1Object),
      v1Object,
      v1Hash,
    });
    assert.deepEqual(r.refusals, []);
    assert.equal(r.ok, true);
  });

  test("a V3 receipt with a zero agentId and no requester metadata is refused", () => {
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: LEGACY_ZERO_AGENT_ID_BYTES32,
      version: 3,
      committedMetadataHash: H("11"),
    });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join(" "), /no V3 evidence/);
  });

  test("a direct receipt whose policy owner is not the proven wallet is refused", () => {
    const { e, hash } = v3();
    const r = verifyReceiptRequester({
      legacyAgentIdBytes32: LEGACY_ZERO_AGENT_ID_BYTES32,
      version: 3,
      committedMetadataHash: hash,
      v3: e,
      provenPolicyOwner: AGENT,
    });
    assert.equal(r.ok, false);
    assert.match(r.refusals.join(" "), /proven direct wallet/);
  });
});

describe("presentation never renders the zero as an agent", () => {
  test("a direct account reads as an Untch account with no marketplace buyer", () => {
    const p = presentRequester(directRequester());
    assert.deepEqual(p, {
      requester: "Untch account",
      marketplaceBuyer: "None",
      sellerAsp: "6086",
      workerAgent: "6086",
      service: "owned_work.demo",
    });
  });

  test("none of the forbidden renderings appear anywhere in the presentation", () => {
    const rendered = JSON.stringify(presentRequester(directRequester()));
    for (const banned of ["Buyer agent 0", "Agent ID 0", "ERC-8004 agent 0", "Marketplace identity 0", "Unknown agent"]) {
      assert.equal(rendered.includes(banned), false, `"${banned}" must never be rendered`);
    }
    assert.equal(/\b0\b/.test(rendered), false, "a bare zero must not appear as a value");
  });

  test("the raw projection carries the bytes AND the semantics, never one alone", () => {
    const raw = rawLegacyAgentProjection(directRequester());
    assert.equal(raw.legacyAgentId, LEGACY_ZERO_AGENT_ID_BYTES32);
    assert.equal(raw.legacyAgentIdSemantics, LEGACY_AGENT_ID_SEMANTICS_V3);
  });

  test("a marketplace requester renders its real agent id", () => {
    const p = presentRequester(marketplaceRequester());
    assert.equal(p.marketplaceBuyer, "6047");
    assert.match(p.requester, /Marketplace agent/);
  });
});

describe("projections publish commitments and never identifiers", () => {
  test("the public projection contains no raw accountId and no wallet binding id", () => {
    const report = projectionReportV3(assemble().evidence);
    assert.equal(report.rawAccountIdPresentInPublic, false);
    assert.equal(report.walletBindingIdPresentInPublic, false);
    assert.equal(report.accountRefHashPresentInPublic, true);
    assert.equal(report.walletAuthorityRefPresentInPublic, true);
  });

  test("the private projection resolves accountId and walletBindingId", () => {
    const priv = privateDecisionProjectionV3(assemble().evidence);
    assert.equal(priv.accountId, ACCOUNT);
    assert.equal(priv.walletBindingId, "wb_1");
  });

  test("no field on the never-public list survives into a public projection", () => {
    const pub = publicDecisionProjectionV3(assemble().evidence);
    for (const field of NEVER_PUBLIC_FIELDS) {
      assert.equal(field in pub, false, `${field} must not be a public key`);
    }
  });

  /**
   * The allow-list, tested the way it can actually fail: a row arriving with a column nobody thought
   * about. A deny-list would pass this silently; the allow-list has to drop it.
   */
  test("an unknown field on a row is dropped, not passed through", () => {
    const row = {
      ...publicDecisionProjectionV3(assemble().evidence),
      siweMessage: "a signature nobody should publish",
      accountId: ACCOUNT,
      somethingAddedNextQuarter: "unreviewed",
    };
    const out = publicFromRow(row);
    assert.equal("siweMessage" in out, false);
    assert.equal("accountId" in out, false);
    assert.equal("somethingAddedNextQuarter" in out, false);
    assert.equal(JSON.stringify(out).includes(ACCOUNT), false);
    assert.equal(out.accountRefHash, accountRefHash(ACCOUNT));
  });
});
