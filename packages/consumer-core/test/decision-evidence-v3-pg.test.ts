import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { createPool, type Pool } from "../src/db";
import {
  PgDecisionEvidenceStore,
  assembleDecisionEvidenceV3,
  assembleDecisionEvidenceV2,
  isV3Evidence,
  persistDecisionEvidenceV2,
  persistDecisionEvidenceV3,
  type AssembledEvidenceV3,
  type CanonicalQuoteTermsV3,
  type PolicySnapshot,
} from "../src/decision-evidence";
import { accountRefHash, walletAuthorityRef, type RequesterEvidenceV3 } from "../src/requester-principal";

/**
 * The V3 constraints, attempted against real Postgres.
 *
 * WHY EVERY ASSERTION HERE IS A WRITE THAT MUST THROW
 *
 * The application already refuses these shapes, and that is not enough. `assertRequesterEvidenceV3`
 * protects the call sites; the CHECK constraints protect the TABLE, which is what a repair script, a
 * console session or a later migration reaches directly. A rule that lives only in TypeScript is a
 * rule that stops existing the moment somebody opens psql — and the property being defended is that a
 * receipt anchored under `agentId = 0` can always be attributed to exactly one requester.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_decision_v3";
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

const ACCOUNT = "acct_v3";
const OWNER = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const AGENT = "0x1111111111111111111111111111111111111111";
const EVALUATED_AT = "2026-08-03T12:00:00.000Z";
const H = (b: string): Hex => `0x${b.repeat(32)}` as Hex;

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

/** Every migration across all packages, in the global filename order boot applies them in. */
function allMigrations(): { name: string; sql: string }[] {
  const files: { name: string; sql: string }[] = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES, entry.name, "migrations");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (f.endsWith(".sql")) files.push({ name: f, sql: readFileSync(join(dir, f), "utf8") });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function refuses(fn: () => Promise<unknown>, expect: RegExp): Promise<void> {
  let caught: Error | null = null;
  try {
    await fn();
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, "the write must be refused, not silently accepted");
  assert.match(caught.message, expect);
}

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

function snapshot(): PolicySnapshot {
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
  };
}

function quoteTerms(r: RequesterEvidenceV3): CanonicalQuoteTermsV3 {
  return {
    quoteSchemaVersion: 3,
    lineage: "lin_1",
    version: 1,
    requesterPrincipalKind: r.requesterPrincipalKind,
    requesterPrincipalNamespace: r.requesterPrincipalNamespace,
    requesterPrincipalRef: r.requesterPrincipalRef,
    accountRefHash: r.accountRefHash,
    walletAuthorityRef: r.walletAuthorityRef,
    marketplace: null,
    sellerAspId: r.sellerAspId,
    workerAgentId: r.workerAgentId,
    serviceId: r.serviceId,
    policyId: "7",
    policyHash: H("44"),
    policyOwner: OWNER,
    governedAgent: AGENT,
    amount: "4.00",
    asset: "USDT0",
    chain: "eip155:196",
    recipient: OWNER,
    provider: "untch",
    capability: "owned_work.demo",
    paramsHash: H("aa"),
    acceptanceHash: H("bb"),
    expiry: "2026-08-04T00:00:00.000Z",
    nonce: "12345",
  };
}

function assemble(decisionId: string, r: RequesterEvidenceV3 = directRequester()): AssembledEvidenceV3 {
  return assembleDecisionEvidenceV3({
    decisionId,
    intentId: `int_${decisionId}`,
    intentHash: H("11"),
    accountId: ACCOUNT,
    walletBindingId: "wb_1",
    requester: r,
    policyId: "7",
    policyHash: H("44"),
    policyOwner: OWNER,
    governedAgent: AGENT,
    snapshot: snapshot(),
    quoteTerms: quoteTerms(r),
    engineVersion: "policy-engine@1.4.0",
    ruleManifestHash: H("cc"),
    decision: "APPROVED",
    ruleTrace: [{ rule: "perCall", outcome: "pass" }],
    evaluatedAt: EVALUATED_AT,
  });
}

/** The columns a V3 row needs, so a test can knock exactly one out and see the table refuse it. */
const V3_COLUMNS = [
  "decision_id", "intent_id", "intent_hash", "account_id", "account_ref_hash", "policy_id", "policy_hash",
  "policy_snapshot_hash", "quote_digest", "engine_version", "rule_manifest_hash", "decision", "rule_trace",
  "evaluated_at", "metadata_schema_version", "completeness", "requester_principal_kind",
  "requester_principal_namespace", "requester_principal_ref", "wallet_authority_ref", "wallet_binding_id",
  "onchain_buyer_agent_id", "buyer_agent_id_semantics", "buyer_agent_id", "marketplace",
  "marketplace_binding_id", "seller_asp_id", "worker_agent_id", "service_id", "policy_owner",
  "governed_agent", "policy_selection_semantics",
] as const;

describe(
  "a V3 decision is complete and coherent, or the table refuses it",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    let pool: Pool;
    let store: PgDecisionEvidenceStore;
    let SNAPSHOT_HASH: Hex;

    before(async () => {
      const admin = createPool(TEST_DB!);
      try {
        await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
          if ((err as { code?: string }).code !== "42P04") throw err;
        });
      } finally {
        await admin.end();
      }
      pool = createPool(ownDatabaseUrl());
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      for (const m of allMigrations()) await pool.query(m.sql);
      store = new PgDecisionEvidenceStore(pool);
      // The raw-insert base row must be complete in every way EXCEPT the field a test knocks out, or
      // `untch_decision_v3_is_complete` fires first and the test passes for the wrong reason.
      SNAPSHOT_HASH = await store.putPolicySnapshot(snapshot());
    });

    after(async () => {
      await pool.end();
    });

    /**
     * Insert a raw row, so the CHECK constraints are what is under test rather than the assembler.
     *
     * The id comes from a counter rather than from the overrides. Deriving it from the payload made
     * two different attempts collide on the primary key, and a duplicate-key error looks exactly like
     * a passing refusal to a test that only checks that something threw.
     */
    let seq = 0;
    const rawInsert = (over: Partial<Record<(typeof V3_COLUMNS)[number], unknown>> = {}) => {
      const values: Record<string, unknown> = {
        decision_id: `dec_raw_${++seq}`,
        intent_id: "int_raw",
        intent_hash: H("11"),
        account_id: ACCOUNT,
        account_ref_hash: accountRefHash(ACCOUNT),
        policy_id: "7",
        policy_hash: H("44"),
        policy_snapshot_hash: SNAPSHOT_HASH,
        quote_digest: H("dd"),
        engine_version: "policy-engine@1.4.0",
        rule_manifest_hash: H("cc"),
        decision: "APPROVED",
        rule_trace: "[]",
        evaluated_at: EVALUATED_AT,
        metadata_schema_version: 3,
        completeness: "V3_COMPLETE",
        requester_principal_kind: "untch_account",
        requester_principal_namespace: "untch-account",
        requester_principal_ref: accountRefHash(ACCOUNT),
        wallet_authority_ref: AUTHORITY,
        wallet_binding_id: "wb_1",
        onchain_buyer_agent_id: "0",
        buyer_agent_id_semantics: "no_marketplace_buyer",
        buyer_agent_id: null,
        marketplace: null,
        marketplace_binding_id: null,
        seller_asp_id: "6086",
        worker_agent_id: "6086",
        service_id: "owned_work.demo",
        policy_owner: OWNER,
        governed_agent: AGENT,
        policy_selection_semantics: "exact_offchain_policy_id_legacy_onchain_policy_hash",
        ...over,
      };
      const cols = V3_COLUMNS.filter((c) => c in values);
      const params = cols.map((_, i) => `$${i + 1}`);
      return pool.query(
        `INSERT INTO untch_decision_evidence (${cols.join(", ")}) VALUES (${params.join(", ")})`,
        cols.map((c) => values[c]),
      );
    };

    test("a complete direct V3 decision persists, and reads back as V3", async () => {
      const a = assemble("dec_ok_direct");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await persistDecisionEvidenceV3(client as never, a);
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      const read = await store.getDecision("dec_ok_direct");
      assert.ok(read);
      assert.equal(isV3Evidence(read), true);
      if (!isV3Evidence(read)) return;
      assert.equal(read.requesterPrincipalKind, "untch_account");
      assert.equal(read.onchainBuyerAgentId, "0");
      assert.equal(read.buyerAgentId, null);
      assert.equal(read.marketplace, null);
      assert.equal(read.walletAuthorityRef, AUTHORITY);
      assert.equal(read.policySelectionSemantics, "exact_offchain_policy_id_legacy_onchain_policy_hash");
      assert.equal(read.completeness, "V3_COMPLETE");
    });

    test("a complete marketplace V3 decision persists", async () => {
      const r: RequesterEvidenceV3 = {
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
      };
      const a = assemble("dec_ok_market", r);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await persistDecisionEvidenceV3(client as never, a);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const read = await store.getDecision("dec_ok_market");
      assert.ok(read && isV3Evidence(read));
      if (!read || !isV3Evidence(read)) return;
      assert.equal(read.buyerAgentId, "6047");
      assert.equal(read.marketplaceBindingId, "mb_1");
    });

    // ── Incompleteness, one field at a time ────────────────────────────────────

    const REQUIRED = [
      "wallet_authority_ref",
      "wallet_binding_id",
      "requester_principal_kind",
      "requester_principal_namespace",
      "requester_principal_ref",
      "onchain_buyer_agent_id",
      "buyer_agent_id_semantics",
      "seller_asp_id",
      "worker_agent_id",
      "service_id",
      "policy_owner",
      "governed_agent",
      "policy_selection_semantics",
      "quote_digest",
      "engine_version",
      "rule_manifest_hash",
    ] as const;

    for (const column of REQUIRED) {
      test(`a V3 row missing ${column} is refused by the table`, async () => {
        await refuses(() => rawInsert({ [column]: null }), /untch_decision_v3_/);
      });
    }

    // ── A direct row cannot carry marketplace identity ─────────────────────────

    test("a direct V3 decision cannot carry a nonzero buyerAgentId", async () => {
      await refuses(
        () => rawInsert({ onchain_buyer_agent_id: "6047" }),
        /untch_decision_v3_direct_account_shape/,
      );
    });

    test("a direct V3 decision cannot carry a marketplace", async () => {
      await refuses(() => rawInsert({ marketplace: "okx" }), /untch_decision_v3_direct_account_shape/);
    });

    test("a direct V3 decision cannot carry a marketplace binding id", async () => {
      await refuses(() => rawInsert({ marketplace_binding_id: "mb_1" }), /untch_decision_v3_direct_account_shape/);
    });

    test("a direct V3 decision cannot carry a buyer agent id", async () => {
      await refuses(() => rawInsert({ buyer_agent_id: "6047" }), /untch_decision_v3_direct_account_shape/);
    });

    test("a direct V3 decision cannot claim marketplace semantics", async () => {
      await refuses(
        () => rawInsert({ buyer_agent_id_semantics: "verified_marketplace_agent" }),
        /untch_decision_v3_direct_account_shape/,
      );
    });

    test("a direct V3 decision's reference must BE its accountRefHash", async () => {
      await refuses(
        () => rawInsert({ requester_principal_ref: H("99") }),
        /untch_decision_v3_direct_account_shape/,
      );
    });

    test("a direct V3 decision cannot be namespaced to a marketplace", async () => {
      await refuses(
        () => rawInsert({ requester_principal_namespace: "okx-ai" }),
        /untch_decision_v3_direct_account_shape/,
      );
    });

    // ── A marketplace row must actually name a verified agent ──────────────────

    const marketplaceRow = (over: Record<string, unknown>) =>
      rawInsert({
        requester_principal_kind: "marketplace_agent",
        requester_principal_namespace: "okx-ai",
        requester_principal_ref: "okx-ai:6047",
        onchain_buyer_agent_id: "6047",
        buyer_agent_id: "6047",
        buyer_agent_id_semantics: "verified_marketplace_agent",
        marketplace: "okx",
        marketplace_binding_id: "mb_1",
        ...over,
      });

    test("a marketplace V3 decision cannot carry a zero buyerAgentId", async () => {
      await refuses(
        () => marketplaceRow({ onchain_buyer_agent_id: "0", buyer_agent_id: "0", requester_principal_ref: "okx-ai:0" }),
        /untch_decision_v3_marketplace_shape/,
      );
    });

    test("a marketplace V3 decision cannot omit its binding", async () => {
      await refuses(() => marketplaceRow({ marketplace_binding_id: null }), /untch_decision_v3_/);
    });

    test("a marketplace V3 decision's on-chain id must equal its buyer agent id", async () => {
      await refuses(() => marketplaceRow({ buyer_agent_id: "6048" }), /untch_decision_v3_marketplace_shape/);
    });

    test("a marketplace V3 decision cannot claim direct semantics", async () => {
      await refuses(
        () => marketplaceRow({ buyer_agent_id_semantics: "no_marketplace_buyer" }),
        /untch_decision_v3_marketplace_shape/,
      );
    });

    test("a marketplace V3 reference must be namespace:agentId", async () => {
      await refuses(() => marketplaceRow({ requester_principal_ref: "6047" }), /untch_decision_v3_marketplace_shape/);
    });

    test("a third requester kind cannot be invented by INSERT", async () => {
      await refuses(
        () => rawInsert({ requester_principal_kind: "operator" }),
        /untch_decision_v3_requester_kind_known/,
      );
    });

    test("an on-chain buyer agent id that is not a uint is refused", async () => {
      await refuses(
        () => rawInsert({ onchain_buyer_agent_id: OWNER }),
        /untch_decision_v3_onchain_buyer_is_uint|untch_decision_v3_direct_account_shape/,
      );
    });

    test("a row cannot claim V3_COMPLETE at another schema version", async () => {
      await refuses(
        () => rawInsert({ metadata_schema_version: 2, completeness: "V3_COMPLETE" }),
        /untch_decision_completeness_matches_version/,
      );
    });

    // ── V1 and V2 remain exactly as they were ──────────────────────────────────

    test("a V2 row still persists and still reads back as V2", async () => {
      const v2 = assembleDecisionEvidenceV2({
        decisionId: "dec_v2_still_works",
        intentId: "int_v2",
        intentHash: H("11"),
        accountId: ACCOUNT,
        policyId: "7",
        policyHash: H("44"),
        snapshot: snapshot(),
        quoteTerms: {
          lineage: "lin_v2",
          version: 1,
          amount: "4.00",
          asset: "USDT0",
          chain: "eip155:196",
          provider: "untch",
          capability: "owned_work.demo",
          recipient: OWNER,
          paramsHash: H("aa"),
          acceptanceHash: H("bb"),
          expiry: "2026-08-04T00:00:00.000Z",
          nonce: "12345",
        },
        engineVersion: "policy-engine@1.4.0",
        ruleManifestHash: H("cc"),
        decision: "APPROVED",
        ruleTrace: [],
        evaluatedAt: EVALUATED_AT,
      });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await persistDecisionEvidenceV2(client as never, v2);
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      const read = await store.getDecision("dec_v2_still_works");
      assert.ok(read);
      assert.equal(read.metadataSchemaVersion, 2);
      assert.equal(read.completeness, "V2_COMPLETE");
      assert.equal(isV3Evidence(read), false, "a V2 row must never read as V3");
    });

    test("a LEGACY_PARTIAL V1 row is still writable and still readable", async () => {
      await pool.query(
        `INSERT INTO untch_decision_evidence
           (decision_id, intent_id, intent_hash, policy_id, decision, evaluated_at,
            metadata_schema_version, completeness)
         VALUES ('dec_v1_legacy','int_v1',$1,'7','APPROVED',$2,1,'LEGACY_PARTIAL')`,
        [H("11"), EVALUATED_AT],
      );
      const read = await store.getDecision("dec_v1_legacy");
      assert.ok(read);
      assert.equal(read.metadataSchemaVersion, 1);
      assert.equal(read.completeness, "LEGACY_PARTIAL");
      assert.equal(isV3Evidence(read), false);
    });

    test("no historical row was silently upgraded by this migration", async () => {
      const { rows } = await pool.query<{ version: number; completeness: string; n: string }>(
        `SELECT metadata_schema_version AS version, completeness, count(*)::text AS n
           FROM untch_decision_evidence
          GROUP BY 1, 2 ORDER BY 1`,
      );
      const v1 = rows.find((r) => r.version === 1);
      const v2 = rows.find((r) => r.version === 2);
      assert.equal(v1?.completeness, "LEGACY_PARTIAL", "the V1 row kept its honest gap");
      assert.equal(v2?.completeness, "V2_COMPLETE", "the V2 row kept its own completeness");
      // And neither acquired requester data out of nowhere.
      const { rows: invented } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM untch_decision_evidence
          WHERE metadata_schema_version < 3 AND requester_principal_kind IS NOT NULL`,
      );
      assert.equal(invented[0]!.n, "0", "a pre-V3 row must never acquire a requester it did not record");
    });
  },
);
