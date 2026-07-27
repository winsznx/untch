/**
 * Reproduce the receipt-sink failure for a completed consumer intent, WITHOUT re-running a paid
 * execution.
 *
 * The activation run completed intent ci_50a37ce77505690e8b45df13 with `receiptId: null`. The bridge
 * swallowed the reason in a bare `catch {}`, so the operator was told "no receipt" and nothing else.
 * This pulls the real stored intent and quote out of production, runs the exact projection and draft
 * the bridge runs, and prints whatever actually throws.
 *
 * Read-only against the database by default. It never enqueues; `draftFromDecision` is pure, so the
 * failure surfaces before anything would be written.
 *
 *   PGURL=... pnpm tsx scripts/consumer-receipt-repro.ts <intentId>
 */
import { createPool } from "../packages/consumer-core/src/db";
import { draftFromDecision } from "../packages/receipt-writer/src/index";
import type { Decision } from "../packages/policy-engine/src/index";
import type { ConsumerIntent, ConsumerQuote } from "../packages/consumer-core/src/index";
import { projectConsumerIntent } from "../services/asp/src/consumer/projection";

const intentId = process.argv[2] ?? "ci_50a37ce77505690e8b45df13";
const url = process.env.PGURL ?? process.env.DATABASE_URL;
if (!url) throw new Error("PGURL or DATABASE_URL required");

// PGSSL=1 rather than an appended sslmode: pg parses sslmode out of the connection string and its
// parsed value wins over the pool option, which reinstates cert verification against Railway's
// self-signed chain.
process.env.PGSSL = "1";
const client = createPool(url.replace(/[?&]sslmode=[^&]*/, ""));

const intentRow = (
  await client.query("SELECT * FROM consumer_intents WHERE intent_id = $1", [intentId])
).rows[0];
if (!intentRow) throw new Error(`no such intent: ${intentId}`);

const quoteRow = (
  await client.query(
    "SELECT * FROM consumer_quotes WHERE intent_id = $1 ORDER BY created_at DESC LIMIT 1",
    [intentId],
  )
).rows[0];
if (!quoteRow) throw new Error(`no quote for ${intentId}`);

console.log(`intent  ${intentId}  state=${intentRow.state}  receipt_id=${intentRow.receipt_id}`);
console.log(`policy  id=${intentRow.policy_id} version=${intentRow.policy_version} hash=${intentRow.policy_hash}`);
console.log(`agent   ${intentRow.requesting_agent_id}`);

const asset = (chain: string, symbol: string, address: string | null, decimals: number) => ({
  chain,
  symbol,
  address,
  decimals,
});

const fundingAsset = asset(
  quoteRow.funding_chain,
  quoteRow.funding_token,
  quoteRow.funding_contract,
  quoteRow.funding_decimals,
);
const settlementAsset = asset(
  quoteRow.settlement_chain,
  quoteRow.settlement_token,
  quoteRow.settlement_contract,
  quoteRow.settlement_decimals,
);
const m = (amount: string, a: ReturnType<typeof asset>) => ({ amount: BigInt(amount), asset: a });

const quote = {
  quoteId: quoteRow.quote_id,
  intentId,
  providerId: quoteRow.provider_id,
  providerCost: m(quoteRow.provider_cost, settlementAsset),
  untchFee: m(quoteRow.untch_fee, fundingAsset),
  spread: m(quoteRow.spread, fundingAsset),
  totalUserAmount: m(quoteRow.total_user_amount, fundingAsset),
  maxAuthorisedAmount: m(quoteRow.max_authorised, fundingAsset),
  settlementRecipient: quoteRow.settlement_recipient,
  settlementChain: quoteRow.settlement_chain,
  settlementAsset,
  providerRef: quoteRow.provider_ref,
  summary: quoteRow.summary,
  terms: quoteRow.terms,
  createdAt: new Date(quoteRow.created_at).toISOString(),
  expiresAt: new Date(quoteRow.expires_at).toISOString(),
  quoteHash: quoteRow.quote_hash,
} as unknown as ConsumerQuote;

const intent = {
  intentId,
  tenantId: intentRow.tenant_id,
  policyId: intentRow.policy_id,
  policyVersion: intentRow.policy_version,
  policyHash: intentRow.policy_hash,
  requestingAgentId: intentRow.requesting_agent_id,
  action: intentRow.action,
  request: intentRow.request,
  state: intentRow.state,
  policyDecision: intentRow.policy_decision,
  correlationId: intentRow.correlation_id,
} as unknown as ConsumerIntent;

const stored = {
  id: intent.policyId,
  version: intent.policyVersion ?? 1,
  policyHash: intent.policyHash ?? `0x${"0".repeat(64)}`,
  owner: "0x0000000000000000000000000000000000000000",
} as unknown as Parameters<typeof projectConsumerIntent>[0]["stored"];

let projected: ReturnType<typeof projectConsumerIntent>;
try {
  projected = projectConsumerIntent({
    intent,
    quote,
    stored,
    deadlineSec: BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000)),
  });
  console.log(`\nPROJECTION OK  intentHash=${projected.intentHash}`);
  console.log(`  endpoint  ${projected.input.endpoint}`);
  console.log(`  category  ${projected.input.category}`);
  console.log(`  amount    ${projected.input.amount}`);
  console.log(`  recipient ${projected.input.recipientAddress}`);
} catch (err) {
  console.error(`\nPROJECTION FAILED: ${(err as Error).message}`);
  await client.end();
  process.exit(1);
}

let draft: ReturnType<typeof draftFromDecision>;
try {
  draft = draftFromDecision(projected.input, intent.policyDecision as unknown as Decision);
  console.log(`\nDRAFT OK  receiptId=${draft.onchain.receiptId}`);
} catch (err) {
  console.error(`\nDRAFT FAILED: ${(err as Error).message}`);
  console.error("  ^ this is what the bare `catch {}` in bridges.ts swallowed");
  const decision = intent.policyDecision as Record<string, unknown> | null;
  console.error(`  stored decision keys: ${decision ? Object.keys(decision).join(", ") : "(null)"}`);
  await client.end();
  process.exit(1);
}

/**
 * The durable write, attempted for real and then rolled back.
 *
 * This is the only step left that can fail, and it is the one a pure unit test cannot cover: the
 * draft is valid TypeScript-side and only the live schema can reject it. Running it inside a
 * transaction that always rolls back reproduces the exact constraint without writing a receipt for a
 * purchase that already completed.
 */
const conn = await client.connect();
try {
  await conn.query("BEGIN");
  const o = draft.onchain;
  await conn.query(
    `INSERT INTO receipts (
       receipt_id, kind, status, intent_hash, policy_id, policy_hash, agent_id, vendor_id,
       amount, token, category, pay_type, task_hash, decision, verify_result, proof_tier,
       metadata_hash, provenance
     ) VALUES ($1,$2,'QUEUED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      o.receiptId, draft.kind, o.intentHash, o.policyId.toString(), o.policyHash, o.agentId,
      o.vendorId, o.amount.toString(), o.token, o.category, o.payType, o.taskHash, o.decision,
      o.verifyResult, o.proofTier, o.metadataHash, draft.provenance ?? null,
    ],
  );
  console.log("INSERT receipts OK");
  const l = draft.ledger;
  if (l) {
    await conn.query(
      `INSERT INTO ledger_entries (
         receipt_id, agent_id, type, amount, token, counterparty, day_key, category_key, vendor_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [o.receiptId, l.agentId, l.type, l.amount, l.token, l.counterparty, l.dayKey, l.categoryKey, l.vendorKey],
    );
    console.log("INSERT ledger_entries OK");
  }
  await conn.query("ROLLBACK");
  console.log("\nDURABLE WRITE OK (rolled back) — nothing in the receipt path rejects this intent");
} catch (err) {
  await conn.query("ROLLBACK");
  console.error(`\nDURABLE WRITE FAILED: ${(err as Error).message}`);
  console.error("  ^ THIS is what the bare `catch {}` in bridges.ts swallowed");
} finally {
  conn.release();
}

await client.end();
