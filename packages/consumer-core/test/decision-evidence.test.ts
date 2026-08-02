import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACCOUNT_REFERENCE_DOMAIN,
  METADATA_SCHEMA_VERSION_V2,
  accountRefHash,
  assertCompleteV2,
  IncompleteEvidenceError,
  metadataHashV2,
  metadataV2Of,
  policySnapshotHashOf,
  publicDecisionProjection,
  privateDecisionProjection,
  quoteDigestOf,
  verifyMetadataCommitment,
  type CanonicalQuoteTerms,
  type DecisionEvidenceV2,
  type PolicySnapshot,
} from "../src/decision-evidence";
import { keccak256, toHex, type Hex } from "viem";

const H = (b: string): Hex => `0x${b.repeat(32)}` as Hex;

const TERMS: CanonicalQuoteTerms = {
  lineage: "ord_demo_1",
  version: 1,
  amount: "6.00",
  asset: "USDT0",
  chain: "eip155:196",
  provider: "untch",
  capability: "owned_work.demo",
  recipient: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
  paramsHash: H("11"),
  acceptanceHash: H("22"),
  expiry: "2026-08-02T18:00:00.000Z",
  nonce: "42",
};

const SNAPSHOT: PolicySnapshot = {
  policyId: "6005881688159874338903650523776790675151043356117181716643196935468657631674",
  policyHash: H("8b"),
  owner: "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64",
  governedAgent: "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64",
  chainId: 196,
  registry: "0xa2177e6d8682367637a3c2af53e2cf8088efa954",
  currency: "USDT0",
  rules: { perCallCap: 8, hardCap: 8, escalateAbove: 5 },
  version: 1,
  expiryAtEval: "2026-09-30T00:00:00.000Z",
  statusAtEval: "ACTIVE",
  activeAtEval: true,
  defaultForAccount: true,
};

function evidence(over: Partial<DecisionEvidenceV2> = {}): DecisionEvidenceV2 {
  return {
    decisionId: "dec_1",
    intentId: "int_1",
    intentHash: H("aa"),
    accountId: "acct_yuznzh6w4a6cvljlskas3nvmdc",
    accountRefHash: accountRefHash("acct_yuznzh6w4a6cvljlskas3nvmdc"),
    policyId: SNAPSHOT.policyId,
    policyHash: SNAPSHOT.policyHash,
    policySnapshotHash: policySnapshotHashOf(SNAPSHOT),
    quoteDigest: quoteDigestOf(TERMS),
    engineVersion: "2",
    ruleManifestHash: H("cc"),
    decision: "ESCALATED_THRESHOLD",
    ruleTrace: [{ rule: "escalate.aboveThreshold", result: "FAIL" }],
    evaluatedAt: "2026-08-02T15:00:01.000Z",
    metadataSchemaVersion: METADATA_SCHEMA_VERSION_V2,
    completeness: "V2_COMPLETE",
    ...over,
  };
}

const commitmentOf = (e: DecisionEvidenceV2): Hex => metadataHashV2(metadataV2Of(e));

describe("the account reference is public, the account id is not", () => {
  test("the reference is domain-separated, so it cannot be replayed from another context", () => {
    const id = "acct_1";
    assert.equal(accountRefHash(id), keccak256(toHex(`${ACCOUNT_REFERENCE_DOMAIN}||${id}`)));
    // A bare hash of the id would be computable by anyone holding that id from anywhere else.
    assert.notEqual(accountRefHash(id), keccak256(toHex(id)));
  });

  test("a different account gives a different reference", () => {
    assert.notEqual(accountRefHash("acct_1"), accountRefHash("acct_2"));
  });

  test("the public projection contains no raw account id, by construction", () => {
    const pub = publicDecisionProjection(evidence());
    assert.equal("accountId" in pub, false);
    assert.equal(JSON.stringify(pub).includes("acct_yuznzh6w4a6cvljlskas3nvmdc"), false);
    assert.ok(pub.accountRefHash);
  });

  test("the private projection resolves it", () => {
    const priv = privateDecisionProjection(evidence());
    assert.equal(priv.accountId, "acct_yuznzh6w4a6cvljlskas3nvmdc");
    assert.ok(priv.ruleTrace);
  });
});

describe("the quote digest is the terms and nothing else", () => {
  test("identical terms give an identical digest", () => {
    assert.equal(quoteDigestOf(TERMS), quoteDigestOf({ ...TERMS }));
  });

  test("every term changes it", () => {
    const base = quoteDigestOf(TERMS);
    const variants: Partial<CanonicalQuoteTerms>[] = [
      { amount: "6.50" },
      { version: 2 },
      { lineage: "ord_demo_2" },
      { asset: "USDC" },
      { chain: "eip155:8453" },
      { provider: "other" },
      { capability: "battle_card" },
      { recipient: "0x1111111111111111111111111111111111111111" },
      { paramsHash: H("33") },
      { acceptanceHash: H("44") },
      { expiry: "2026-08-02T19:00:00.000Z" },
      { nonce: "43" },
    ];
    for (const v of variants) {
      assert.notEqual(quoteDigestOf({ ...TERMS, ...v }), base, `${Object.keys(v)[0]} did not change the digest`);
    }
  });

  test("a re-quote at a different amount is a different digest, which is what supersession rests on", () => {
    const six = quoteDigestOf(TERMS);
    const sixFifty = quoteDigestOf({ ...TERMS, amount: "6.50", version: 2, nonce: "43" });
    assert.notEqual(six, sixFifty);
  });
});

describe("the policy snapshot is immutable content", () => {
  test("every snapshot field changes the hash", () => {
    const base = policySnapshotHashOf(SNAPSHOT);
    const variants: Partial<PolicySnapshot>[] = [
      { policyId: "1" },
      { policyHash: H("99") },
      { owner: "0x1111111111111111111111111111111111111111" },
      { governedAgent: "0x2222222222222222222222222222222222222222" },
      { chainId: 1952 },
      { registry: "0x3333333333333333333333333333333333333333" },
      { currency: "USDC" },
      { rules: { perCallCap: 9 } },
      { version: 2 },
      { expiryAtEval: "2026-10-01T00:00:00.000Z" },
      { statusAtEval: "PAUSED" },
      { activeAtEval: false },
      { defaultForAccount: false },
    ];
    for (const v of variants) {
      assert.notEqual(policySnapshotHashOf({ ...SNAPSHOT, ...v }), base, `${Object.keys(v)[0]} did not change the hash`);
    }
  });

  test("key order does not change the hash, because the canonicaliser is RFC 8785", () => {
    const reordered = Object.fromEntries(Object.entries(SNAPSHOT).reverse()) as unknown as PolicySnapshot;
    assert.equal(policySnapshotHashOf(reordered), policySnapshotHashOf(SNAPSHOT));
  });
});

describe("the V2 metadata commitment covers every field it promises", () => {
  test("changing any committed field changes the commitment", () => {
    const base = commitmentOf(evidence());
    const variants: Partial<DecisionEvidenceV2>[] = [
      { accountRefHash: accountRefHash("acct_other") },
      { quoteDigest: quoteDigestOf({ ...TERMS, amount: "6.50" }) },
      { policySnapshotHash: policySnapshotHashOf({ ...SNAPSHOT, version: 2 }) },
      { policyHash: H("99") },
      { engineVersion: "3" },
      { ruleManifestHash: H("dd") },
      { intentHash: H("bb") },
      { decision: "APPROVED" },
      { evaluatedAt: "2026-08-02T15:00:02.000Z" },
    ];
    for (const v of variants) {
      assert.notEqual(commitmentOf(evidence(v)), base, `${Object.keys(v)[0]} did not change the commitment`);
    }
  });

  test("a V2 commitment verifies, and a tampered one does not", () => {
    const e = evidence();
    const committed = commitmentOf(e);
    assert.equal(verifyMetadataCommitment({ committed, version: 2, v2: metadataV2Of(e) }).ok, true);

    // Tamper with one field after commitment.
    const tampered = metadataV2Of(evidence({ decision: "APPROVED" }));
    const result = verifyMetadataCommitment({ committed, version: 2, v2: tampered });
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /does not equal committed/);
  });

  test("a V1 receipt still verifies under its own algorithm", () => {
    // V1 hashed `keccak256(toHex(JSON.stringify(obj)))`. It keeps that algorithm permanently: changing
    // it would un-verify every receipt already anchored.
    const v1Hash = (v: unknown): Hex => keccak256(toHex(JSON.stringify(v)));
    const obj = { intentHash: H("aa"), decision: "APPROVED", evaluatedAt: "2026-01-01T00:00:00Z" };
    const committed = v1Hash(obj);
    assert.equal(verifyMetadataCommitment({ committed, version: 1, v1Object: obj, v1Hash }).ok, true);
    assert.equal(
      verifyMetadataCommitment({ committed, version: 1, v1Object: { ...obj, decision: "BLOCKED" }, v1Hash }).ok,
      false,
    );
  });

  test("a V2 verification without the V2 object refuses rather than passing", () => {
    const r = verifyMetadataCommitment({ committed: H("11"), version: 2 });
    assert.equal(r.ok, false);
  });
});

describe("an incomplete V2 decision cannot be persisted", () => {
  const required = [
    "decisionId", "intentId", "intentHash", "accountId", "accountRefHash", "policyId",
    "policyHash", "policySnapshotHash", "quoteDigest", "engineVersion", "ruleManifestHash",
    "decision", "evaluatedAt",
  ] as const;

  for (const field of required) {
    test(`omitting ${field} is refused, and the error names it`, () => {
      const e = { ...evidence(), [field]: "" } as DecisionEvidenceV2;
      assert.throws(
        () => assertCompleteV2(e),
        (err: unknown) => {
          assert.ok(err instanceof IncompleteEvidenceError);
          assert.ok(err.missing.includes(field), `missing did not name ${field}`);
          return true;
        },
      );
    });
  }

  test("a complete V2 decision passes", () => {
    assert.doesNotThrow(() => assertCompleteV2(evidence()));
  });

  test("claiming version 2 with a legacy schema number is refused", () => {
    const e = { ...evidence(), metadataSchemaVersion: 1 as const };
    assert.throws(() => assertCompleteV2(e), IncompleteEvidenceError);
  });
});

describe("no BigInt reaches JSON", () => {
  test("every V2 object serialises", () => {
    // The draft route returned 500 for its entire life because a BigInt reached `res.json`. Every
    // object this module produces is asserted serialisable so that cannot recur here.
    assert.doesNotThrow(() => JSON.stringify(metadataV2Of(evidence())));
    assert.doesNotThrow(() => JSON.stringify(publicDecisionProjection(evidence())));
    assert.doesNotThrow(() => JSON.stringify(privateDecisionProjection(evidence())));
    assert.doesNotThrow(() => JSON.stringify(SNAPSHOT));
    assert.doesNotThrow(() => JSON.stringify(TERMS));
  });
});
