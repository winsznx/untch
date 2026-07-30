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
 *   PGURL=… pnpm receipt:redrive                          # report every degraded batch
 *   PGURL=… pnpm receipt:redrive --batch 27 --apply       # re-drive exactly one
 *
 * `--apply` REQUIRES `--batch`, and that is not tidiness.
 *
 * This script used to re-drive every degraded batch it found. On 2026-07-30 an operator reached for it
 * to re-drive ONE approved batch and it would have re-driven six, submitting anchor transactions for
 * five batches nobody had approved. The dry run showed all six, which is correct for a report and is
 * exactly what makes the blanket apply easy to miss.
 *
 * Reporting stays broad because seeing the whole picture is the point of a report. Mutation is narrow
 * because "which batch" is a decision, and a default that answers it for you is a default that will
 * eventually answer it wrongly.
 */
import { createPublicClient, http } from "viem";
import { createPool } from "../packages/consumer-core/src/db";
import { PgReceiptsRepo } from "../packages/receipt-writer/src/repo-pg";

const APPLY = process.argv.includes("--apply");

/** The one batch `--apply` may touch. Absent is a refusal, never "all of them". */
const BATCH_ARG = ((): number | null => {
  const i = process.argv.indexOf("--batch");
  if (i < 0 || i + 1 >= process.argv.length) return null;
  const raw = process.argv[i + 1] ?? "";
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--batch must be a positive integer batch id, got '${raw}'`);
    process.exit(2);
  }
  return n;
})();

if (APPLY && BATCH_ARG === null) {
  console.error(
    "REFUSED: --apply requires --batch <id>.\n" +
      "  Re-driving every degraded batch would submit anchor transactions for batches nobody named.\n" +
      "  Run without --apply to see the list, then name the one you mean.",
  );
  process.exit(2);
}
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
  console.log("\nREPORT ONLY — pass --batch <id> --apply to re-drive exactly one. The worker anchors it on its next tick.");
  await pool.end();
  process.exit(0);
}

const target = degraded.find((b) => b.id === BATCH_ARG);
if (!target) {
  /**
   * Unknown and not-degraded are both refusals, and the message distinguishes them.
   *
   * "Batch 99 does not exist" and "batch 27 already confirmed" are different mistakes, and an operator
   * who cannot tell them apart will retry the wrong one.
   */
  const exists = (await repo.batchesByStatus("CONFIRMED")).some((b) => b.id === BATCH_ARG);
  console.error(
    exists
      ? `REFUSED: batch ${BATCH_ARG} is CONFIRMED, not DEGRADED_UNANCHORED. Re-driving it would double-anchor.`
      : `REFUSED: batch ${BATCH_ARG} is not in the degraded set. Run without --apply to see what is.`,
  );
  await pool.end();
  process.exit(2);
}

const ok = await repo.redriveDegraded(target.id);
// `redriveDegraded` guards status in its WHERE clause, so a repeat is a no-op rather than a second
// transition. `false` therefore means "already moved", which is the idempotent outcome, not a failure.
console.log(
  ok
    ? `re-drove batch ${target.id} → PENDING`
    : `batch ${target.id} was NOT re-driven (no longer degraded) — nothing changed`,
);
console.log(`untouched: ${degraded.filter((b) => b.id !== target.id).map((b) => b.id).join(", ") || "none"}`);

console.log("\nDone. The receipt-writer worker anchors PENDING batches on its next tick; poll `receipts.status`.");
await pool.end();
