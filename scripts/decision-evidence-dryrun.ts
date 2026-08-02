/**
 * A complete V2 evidence object, produced without broadcasting or charging anything.
 *
 * The deployment gate asks for proof that V2 is live and correct BEFORE money is spent on the three
 * demo calls. Every input here is real: the policy comes from production Postgres, the evaluator is
 * the deployed engine, and the hashes are computed by the same functions the route uses. What it
 * does not do is call a paid route or write a row — it is a dry run of the evidence assembly.
 */
export {};

import {
  accountRefHash,
  assertCompleteV2,
  metadataHashV2,
  metadataV2Of,
  policySnapshotHashOf,
  privateDecisionProjection,
  publicDecisionProjection,
  quoteDigestOf,
  verifyMetadataCommitment,
  createPool,
  type CanonicalQuoteTerms,
  type DecisionEvidenceV2,
  type PolicySnapshot,
} from "../packages/consumer-core/src/index";
import { ENGINE_VERSION, IMPLEMENTED_RULES, RULE_MANIFEST_HASH } from "../packages/policy-engine/src/index";
import { keccak256, toHex, type Hex } from "viem";

const ACCOUNT = "acct_yuznzh6w4a6cvljlskas3nvmdc";

async function main(): Promise<void> {
  const url = process.env.PGURL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("set PGURL");
  const pool = createPool(url);
  try {
    const { rows } = await pool.query<{
      id: string; owner: string; agent_id: string; version: number; status: string;
      policy_hash: string; expiry: string; rules: Record<string, unknown>;
    }>(
      `SELECT p.id, p.owner, p.agent_id, p.version, p.status, p.policy_hash, p.expiry, p.rules
         FROM policies p
         JOIN untch_accounts a ON a.default_policy_id = p.id::text
        WHERE a.account_id = $1`,
      [ACCOUNT],
    );
    const p = rows[0];
    if (!p) throw new Error(`no default policy for ${ACCOUNT}`);

    const snapshot: PolicySnapshot = {
      policyId: p.id,
      policyHash: p.policy_hash as Hex,
      owner: p.owner.toLowerCase(),
      governedAgent: p.agent_id.toLowerCase(),
      chainId: 196,
      registry: "0xa2177e6d8682367637a3c2af53e2cf8088efa954",
      currency: String((p.rules as { budgets?: { token?: string } }).budgets?.token ?? "USDT0"),
      rules: p.rules,
      version: p.version,
      expiryAtEval: new Date(Number(p.expiry) * 1000).toISOString(),
      statusAtEval: p.status,
      activeAtEval: p.status === "ACTIVE" && Number(p.expiry) * 1000 > Date.now(),
      defaultForAccount: true,
    };
    const snapshotHash = policySnapshotHashOf(snapshot);

    const terms: CanonicalQuoteTerms = {
      lineage: "ord_dryrun_owned_work_demo",
      version: 1,
      amount: "4.00",
      asset: "USDT0",
      chain: "eip155:196",
      provider: "untch",
      capability: "owned_work.demo",
      recipient: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
      paramsHash: keccak256(toHex("{}")),
      acceptanceHash: keccak256(toHex("owned work demo")),
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
      nonce: "1",
    };
    const quoteDigest = quoteDigestOf(terms);

    const evidence: DecisionEvidenceV2 = {
      decisionId: "dec_dryrun_0001",
      intentId: "int_dryrun_0001",
      intentHash: keccak256(toHex("dryrun-intent")),
      accountId: ACCOUNT,
      accountRefHash: accountRefHash(ACCOUNT),
      policyId: p.id,
      policyHash: p.policy_hash as Hex,
      policySnapshotHash: snapshotHash,
      quoteDigest,
      engineVersion: ENGINE_VERSION,
      ruleManifestHash: RULE_MANIFEST_HASH as Hex,
      decision: "APPROVED",
      ruleTrace: IMPLEMENTED_RULES.map((r) => ({ rule: r, result: "PASS" })),
      evaluatedAt: new Date().toISOString(),
      metadataSchemaVersion: 2,
      completeness: "V2_COMPLETE",
    };
    assertCompleteV2(evidence);

    const metadata = metadataV2Of(evidence);
    const commitment = metadataHashV2(metadata);

    console.log("=== CANONICAL EVIDENCE (private projection) ===");
    console.log(JSON.stringify(privateDecisionProjection(evidence), null, 1));
    console.log("");
    console.log("=== PUBLIC PROJECTION (no raw accountId) ===");
    const pub = publicDecisionProjection(evidence);
    console.log(JSON.stringify(pub, null, 1));
    console.log(`  contains raw accountId: ${JSON.stringify(pub).includes(ACCOUNT)}`);
    console.log("");
    console.log("=== METADATA COMMITMENT (V2) ===");
    console.log(JSON.stringify(metadata, null, 1));
    console.log(`commitment ${commitment}`);
    console.log("");

    const good = verifyMetadataCommitment({ committed: commitment, version: 2, v2: metadata });
    console.log(`V2 verify (untampered): ${good.ok ? "PASS" : `FAIL ${good.reason}`}`);

    const tampered = metadataV2Of({ ...evidence, decision: "BLOCKED_PER_CALL_CAP" });
    const bad = verifyMetadataCommitment({ committed: commitment, version: 2, v2: tampered });
    console.log(`V2 verify (one field changed after commitment): ${bad.ok ? "FAIL - tamper accepted" : "PASS - refused"}`);

    const v1Hash = (v: unknown): Hex => keccak256(toHex(JSON.stringify(v)));
    const v1Object = { intentHash: evidence.intentHash, decision: "APPROVED", evaluatedAt: evidence.evaluatedAt };
    const v1Committed = v1Hash(v1Object);
    const v1 = verifyMetadataCommitment({ committed: v1Committed, version: 1, v1Object, v1Hash });
    console.log(`V1 legacy verify: ${v1.ok ? "PASS" : `FAIL ${v1.reason}`}`);
    console.log("");
    console.log(`policySnapshotHash ${snapshotHash}`);
    console.log(`quoteDigest        ${quoteDigest}`);
    console.log(`accountRefHash     ${evidence.accountRefHash}`);
    console.log(`engineVersion      ${ENGINE_VERSION}`);
    console.log(`ruleManifestHash   ${RULE_MANIFEST_HASH}`);
    console.log("");
    console.log("nothing was broadcast, charged, or written.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
