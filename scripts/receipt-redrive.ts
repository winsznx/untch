/**
 * Operator re-drive for a receipt batch that gave up.
 *
 * `DEGRADED_UNANCHORED` means the anchorer burned its retry budget and stopped. That is correct
 * behaviour — a batch failing against a condition nothing has changed must not consume the loop
 * forever, and the durable ledger stays authoritative whether or not the anchor lands. But it is not
 * the same as "this can never be anchored". The budget is exhausted precisely when something OUTSIDE
 * the process is wrong: an RPC outage, a paused contract, or a signer with no gas.
 *
 * This re-drives the SAME batch carrying the SAME receiptId. It never mints a replacement — a new id
 * would break every reference already handed out and would quietly assert the original decision did
 * not happen.
 *
 * Run it only AFTER fixing the cause. It checks the signer's gas first and refuses otherwise, because
 * re-driving into the same wall just burns the budget again and leaves a worse log.
 *
 *   PGURL=… XLAYER_RPC_URL=… pnpm tsx scripts/receipt-redrive.ts            # report only
 *   PGURL=… XLAYER_RPC_URL=… pnpm tsx scripts/receipt-redrive.ts --apply    # re-drive
 */
import { createPublicClient, http } from "viem";
import { createPool } from "../packages/consumer-core/src/db";
import { PgReceiptsRepo } from "../packages/receipt-writer/src/repo-pg";

const APPLY = process.argv.includes("--apply");
const RPC = process.env.XLAYER_RPC_URL?.trim() || "https://rpc.xlayer.tech";
/** Enough for a `logReceipts` call with headroom; a batch has measured at ~42k gas for one receipt. */
const MIN_GAS_WEI = 2_000_000_000_000_000n; // 0.002 OKB

const url = process.env.PGURL ?? process.env.DATABASE_URL;
if (!url) throw new Error("PGURL or DATABASE_URL required");

process.env.PGSSL = "1";
const pool = createPool(url.replace(/[?&]sslmode=[^&]*/, ""));
const repo = new PgReceiptsRepo(pool);

const degraded = await repo.batchesByStatus("DEGRADED_UNANCHORED");
if (degraded.length === 0) {
  console.log("no DEGRADED_UNANCHORED batches — nothing to re-drive");
  await pool.end();
  process.exit(0);
}

console.log(`${degraded.length} degraded batch(es):`);
for (const b of degraded) {
  console.log(`  batch ${b.id}  receipts=${b.receiptCount}  attempts=${b.attempts}`);
}

// The signer whose gas exhaustion is the usual cause. Read from the same env the worker uses.
const signer = process.env.RECEIPT_WRITER_ADDRESS?.trim();
if (signer) {
  const client = createPublicClient({ transport: http(RPC) });
  const bal = await client.getBalance({ address: signer as `0x${string}` });
  const okb = (Number(bal) / 1e18).toFixed(6);
  console.log(`\nsigner ${signer} holds ${okb} OKB`);
  if (bal < MIN_GAS_WEI) {
    console.error(
      `REFUSING: ${okb} OKB is below the ${(Number(MIN_GAS_WEI) / 1e18).toFixed(3)} OKB floor. ` +
        "Re-driving into the same wall re-burns the retry budget and leaves a worse log. Fund the signer first.",
    );
    await pool.end();
    process.exit(1);
  }
} else {
  console.log("\n(RECEIPT_WRITER_ADDRESS unset — skipping the gas pre-check)");
}

if (!APPLY) {
  console.log("\nDRY RUN — pass --apply to re-drive. The worker's anchorer will pick the batch up on its next tick.");
  await pool.end();
  process.exit(0);
}

for (const b of degraded) {
  const ok = await repo.redriveDegraded(b.id);
  console.log(ok ? `re-drove batch ${b.id} → PENDING` : `batch ${b.id} was NOT re-driven (no longer degraded)`);
}

console.log("\nDone. The receipt-writer worker anchors PENDING batches on its next tick; poll `receipts.status`.");
await pool.end();
