import { hashCanonicalJson } from "@untch/canon";
import { verifyDelivery, type AcceptanceCriteria } from "@untch/proof-engine";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { MemoryScoreDataSource } from "./datasource-memory";
import { ViemWalletProfileProvider } from "./rpc";
import { scoreVendor, scoreBuyer } from "./score";
import { ScoreAnchorer } from "./anchor";
import { SCORE_ANCHOR_CHAIN, SCORE_RECEIPTS_CONTRACT, DEFAULT_RPC_URL } from "./config";
import { rootOfSnapshots } from "./merkle";
import type { OrderRecord, VerifyRecord } from "./datasource";

/**
 * One-shot REAL end-to-end §12 proof, self-contained (no seller, no DB):
 *
 *   1. Produce REAL delivery-verification results by running the REAL @untch/proof-engine T0 against a
 *      committed acceptance spec — the verifyResult codes below are the engine's, not hand-set.
 *   2. Seed a data source with those real results + real receipted orders for a real vendor + buyer.
 *   3. Profile the vendor's payout address with REAL on-chain signals over the live X Layer testnet RPC.
 *   4. Compute a REAL deterministic vendor score and buyer score (no LLM, I1).
 *   5. Merkle-root the vendor epoch snapshot and anchor it on the deployed UntchReceipts via a REAL
 *      writer-signed anchorScore transaction (no mocked settlement).
 *   6. INDEPENDENTLY verify the ScoreAnchored event via raw eth_getLogs — decoded client-side, matched
 *      on root+epoch+subjectKind, NOT taken from this script's own report.
 *
 * Needs: WRITER_PRIVATE_KEY (an authorized UntchReceipts writer). RPC_URL / RECEIPTS_CONTRACT default to
 * X Layer testnet + the deployed §10.3 contract.
 * Run: WRITER_PRIVATE_KEY=0x… pnpm --filter @untch/trust-bureau prove:score-anchor
 */

const VENDOR_HOST = "api.vendor.example";
const VENDOR_ID = keccak256(toHex(`untch-vendor:${VENDOR_HOST}`));
const AGENT_ID = toHex(1n, { size: 32 });
// A real X Layer testnet address with genuine history (the UntchReceipts deployer/admin) — so the
// wallet_operational_profile feature reads REAL nonce/balance/code, not a fabricated number.
const PAYOUT: Address = "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b";
const APPROVED_CODE = 1; // frozen on-chain decision code for APPROVED (see receipt-writer mapping).

function realVerify(index: number): VerifyRecord {
  const criteria: AcceptanceCriteria = { requiredFields: ["symbol", "price"] };
  const acceptanceHash = hashCanonicalJson(criteria);
  const outcome = verifyDelivery({
    intentHash: keccak256(toHex(`prove-score-intent:${index}`)),
    acceptanceHash,
    criteria,
    delivery: { payload: { symbol: "OKB", price: 42.5 + index } },
  });
  if (outcome.final !== "VERIFY_PASSED") {
    throw new Error(`expected a real T0 PASS, got ${outcome.final}`);
  }
  return {
    intentHash: keccak256(toHex(`prove-score-intent:${index}`)),
    vendorId: VENDOR_ID,
    agentId: AGENT_ID,
    verifyResult: outcome.verifyResultCode,
    provenance: "store-committed",
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  };
}

function realOrder(index: number): OrderRecord {
  return {
    intentHash: keccak256(toHex(`prove-score-order:${index}`)),
    vendorId: VENDOR_ID,
    agentId: AGENT_ID,
    decision: APPROVED_CODE,
    counterparty: PAYOUT,
    createdAt: new Date(1_700_000_500_000 + index * 1000).toISOString(),
  };
}

async function main(): Promise<void> {
  const writerKey = process.env.WRITER_PRIVATE_KEY?.trim();
  if (!writerKey || !/^0x[0-9a-fA-F]{64}$/.test(writerKey)) {
    throw new Error("WRITER_PRIVATE_KEY (0x 32-byte) is required");
  }
  const rpcUrl = process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
  const contract = (process.env.RECEIPTS_CONTRACT?.trim() as Address | undefined) ?? SCORE_RECEIPTS_CONTRACT;

  const ds = new MemoryScoreDataSource();
  for (let i = 0; i < 12; i++) ds.addOrder(realOrder(i));
  for (let i = 0; i < 6; i++) ds.addVerify(realVerify(i));

  const walletProvider = new ViemWalletProfileProvider({ chain: SCORE_ANCHOR_CHAIN, rpcUrl });

  console.log(`[prove] chain    : ${SCORE_ANCHOR_CHAIN.name} (${SCORE_ANCHOR_CHAIN.id})`);
  console.log(`[prove] contract : ${contract}`);
  console.log(`[prove] vendorId : ${VENDOR_ID}`);

  const vendor = await scoreVendor(ds, VENDOR_ID, { walletProvider, payoutAddress: PAYOUT });
  const buyer = await scoreBuyer(ds, AGENT_ID);

  console.log(
    `[prove] vendor   : score=${vendor.score.toFixed(2)} σ=${vendor.sigma.toFixed(2)} ` +
      `LCB=${vendor.lcb.toFixed(2)} band=${vendor.band} epoch=${vendor.epoch}`,
  );
  console.log(`[prove]   real features   : ${vendor.features.filter((f) => f.source === "observed").map((f) => f.key).join(", ")}`);
  console.log(`[prove]   cold-start prior: ${vendor.coldStartFeatures.join(", ")} (renormalized away, σ widened)`);
  const wallet = vendor.features.find((f) => f.key === "wallet_operational_profile")!;
  console.log(`[prove]   wallet (real RPC): value=${wallet.value.toFixed(2)} — ${wallet.note}`);
  console.log(
    `[prove] buyer    : score=${buyer.score.toFixed(2)} σ=${buyer.sigma.toFixed(2)} ` +
      `LCB=${buyer.lcb.toFixed(2)} band=${buyer.band} (fully real hygiene)`,
  );

  const snapshots = await ds.snapshotsForEpoch("VENDOR", vendor.epoch);
  if (snapshots.length === 0) throw new Error("no vendor snapshots to anchor");
  const expectedRoot: Hex = rootOfSnapshots(snapshots);

  const anchorer = new ScoreAnchorer({ chain: SCORE_ANCHOR_CHAIN, rpcUrl, contract, writerPrivateKey: writerKey as Hex });
  console.log(`[prove] writer   : ${anchorer.writerAddress}`);
  console.log(`[prove] root     : ${expectedRoot} over ${snapshots.length} subject(s)`);
  console.log(`[prove] anchoring anchorScore(root, epoch=${vendor.epoch}, VENDOR) …`);

  const anchored = await anchorer.anchor("VENDOR", vendor.epoch, snapshots);
  if (anchored.root.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error("anchored root disagrees with the independently recomputed root");
  }
  await ds.setAnchoredRoot("VENDOR", vendor.epoch, anchored.root);

  console.log(`[prove] anchor tx: ${anchored.txHash} (block ${anchored.blockNumber})`);
  console.log(`[prove] verifying ScoreAnchored via raw eth_getLogs (independent of this script) …`);

  const matchTx = await anchorer.verifyAnchored(
    { root: anchored.root, epoch: vendor.epoch, subjectKind: "VENDOR" },
    anchored.blockNumber,
    anchored.txHash,
  );
  if (!matchTx) throw new Error(`ScoreAnchored(root=${anchored.root}, epoch=${vendor.epoch}) NOT found on-chain`);

  console.log("");
  console.log("RESULT: PASS — real §12 scores computed, merkle-rooted, and anchored on UntchReceipts.anchorScore.");
  console.log(`root       : ${anchored.root}`);
  console.log(`epoch      : ${vendor.epoch}   subjectKind: VENDOR`);
  console.log(`anchor tx  : ${matchTx}`);
  console.log(`explorer   : https://www.oklink.com/x-layer-testnet/tx/${matchTx}`);
  console.log(`verified   : raw eth_getLogs decoded ScoreAnchored and matched root+epoch+subjectKind`);
}

main().catch((err) => {
  console.error(`[prove] FAIL: ${(err as Error).message}`);
  process.exit(1);
});
