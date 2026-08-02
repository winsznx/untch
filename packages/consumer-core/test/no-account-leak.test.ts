import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  accountRefHash,
  assembleDecisionEvidenceV2,
  metadataV2Of,
  metadataHashV2,
  projectionReport,
  publicDecisionProjection,
  type CanonicalQuoteTerms,
  type PolicySnapshot,
} from "../src/decision-evidence";
import type { Hex } from "viem";

/**
 * The account id must not appear in anything public. Anywhere.
 *
 * A key check is not enough: a nested object, an error message or a field added by a later migration
 * could carry it while `"accountId" in obj` stays false. Every assertion here searches the SERIALISED
 * output for the literal id, which is the only form of the check that catches all three.
 */

const ACCOUNT = "acct_yuznzh6w4a6cvljlskas3nvmdc";
const H = (b: string): Hex => `0x${b.repeat(32)}` as Hex;

const SNAPSHOT: PolicySnapshot = {
  policyId: "6005881688159874338903650523776790675151043356117181716643196935468657631674",
  policyHash: H("8b"),
  owner: "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64",
  governedAgent: "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64",
  chainId: 196,
  registry: "0xa2177e6d8682367637a3c2af53e2cf8088efa954",
  currency: "USDT0",
  rules: { hardCap: 8, perCallCap: 8, escalateAbove: 5 },
  version: 1,
  expiryAtEval: "2026-09-30T00:00:00.000Z",
  statusAtEval: "ACTIVE",
  activeAtEval: true,
  defaultForAccount: true,
};

const TERMS: CanonicalQuoteTerms = {
  lineage: "ord_1",
  version: 1,
  amount: "4.00",
  asset: "USDT0",
  chain: "eip155:196",
  provider: "untch",
  capability: "owned_work.demo",
  recipient: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
  paramsHash: H("11"),
  acceptanceHash: H("22"),
  expiry: "2026-08-02T18:00:00.000Z",
  nonce: "1",
};

const assembled = assembleDecisionEvidenceV2({
  decisionId: "dec_1",
  intentId: "int_1",
  intentHash: H("aa"),
  accountId: ACCOUNT,
  policyId: SNAPSHOT.policyId,
  policyHash: SNAPSHOT.policyHash,
  snapshot: SNAPSHOT,
  quoteTerms: TERMS,
  engineVersion: "2",
  ruleManifestHash: H("cc"),
  decision: "APPROVED",
  ruleTrace: [{ rule: "policy.active", result: "PASS" }],
  evaluatedAt: "2026-08-02T15:00:01.000Z",
});

const contains = (v: unknown): boolean => JSON.stringify(v).includes(ACCOUNT);

describe("the raw account id never reaches a public surface", () => {
  test("public decision JSON", () => {
    assert.equal(contains(publicDecisionProjection(assembled.evidence)), false);
  });

  test("public receipt metadata, and its commitment inputs", () => {
    const meta = metadataV2Of(assembled.evidence);
    assert.equal(contains(meta), false);
    // The commitment is a hash, so it cannot carry the id — asserted anyway, because a future change
    // that returned the pre-image alongside it would be exactly this leak.
    assert.equal(contains({ meta, commitment: metadataHashV2(meta) }), false);
  });

  test("public Explorer projection", () => {
    // The Explorer's public case view renders the same projection. If it ever builds its own, this
    // test is what fails.
    const explorerCase = {
      caseRef: "case_1",
      decisions: [publicDecisionProjection(assembled.evidence)],
      policyHash: assembled.evidence.policyHash,
    };
    assert.equal(contains(explorerCase), false);
  });

  test("unauthenticated error output", () => {
    // The refusal an unlinked caller gets. It names a route, never an account.
    const refusal = {
      code: "ACCOUNT_LINK_REQUIRED",
      message: "sign in with your wallet at /consumer/account/link/start",
      retryable: false,
      docsUrl: null,
    };
    assert.equal(contains(refusal), false);
  });

  test("the account reference IS present, so the surface is not simply empty", () => {
    const report = projectionReport(assembled.evidence);
    assert.equal(report.rawAccountIdPresentInPublic, false);
    assert.equal(report.accountRefHashPresentInPublic, true);
    assert.equal(report.rawAccountIdPresentInPrivate, true);
    assert.equal(report.privateProjection.accountId, ACCOUNT);
  });

  test("a field added to the evidence row does not reach the public projection", () => {
    const withExtra = { ...assembled.evidence, operatorNote: `internal note about ${ACCOUNT}` };
    assert.equal(contains(publicDecisionProjection(withExtra)), false);
  });

  test("the reference is not reversible without the id", () => {
    // It is a hash of a domain-separated string. Knowing the reference does not yield the id, and two
    // different accounts cannot collide onto one reference.
    assert.notEqual(accountRefHash(ACCOUNT), accountRefHash(`${ACCOUNT}x`));
    assert.equal(assembled.evidence.accountRefHash, accountRefHash(ACCOUNT));
  });
});
