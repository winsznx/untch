/**
 * Read-only inspection of the Solana proof gate.
 *
 *   pnpm solana:gate:status
 *
 * The question this exists to answer is the one that matters after a run disconnects: might the
 * treasury's authority already have been used? Guessing is how one authorisation becomes two
 * settlements, so this prints the durable record and, deliberately, offers no way to change it.
 *
 * THERE IS NO RESET FLAG, ON PURPOSE
 *
 * A command that could clear MANUAL_REVIEW would eventually be run by someone who wanted the number to
 * be zero. Releasing a gate requires proving no credential, signature or submission ever existed, and
 * that proof is a judgement about evidence rather than a flag. When this tool says a gate is not
 * releasable it also says which piece of evidence forbids it, which is the input a human needs.
 */

export {};

import {
  PgConsumerStore,
  createPool,
  canReleasePreSign,
  describeProofGate,
} from "../packages/consumer-core/src/index";

const dbUrl = process.env.DATABASE_URL?.trim();
if (!dbUrl) {
  console.error("DATABASE_URL is not set. There is no durable gate to inspect.");
  process.exit(2);
}

async function main(): Promise<void> {
  const store = new PgConsumerStore(createPool(dbUrl as string));
  const rows = await store.listSolanaProofGates(20);

  if (rows.length === 0) {
    console.log("\nNo Solana proof gate has ever been armed.");
    console.log("Production cannot reach the Solana signer without one.\n");
    return;
  }

  console.log(`\n\x1b[1mSolana proof gates (${rows.length}, newest first)\x1b[0m`);
  for (const row of rows) {
    const view = describeProofGate(row);
    const release = canReleasePreSign(row);
    const colour = row.state === "ARMED" ? 33 : row.state === "ACKNOWLEDGED" ? 32 : row.state === "MANUAL_REVIEW" ? 31 : 36;
    console.log(`\n  \x1b[${colour}m${row.state}\x1b[0m  ${row.scope.intentId}`);
    console.log(`    scope hash        ${row.scopeHash.slice(0, 16)}…`);
    for (const [k, v] of Object.entries(view)) {
      if (k === "state" || k === "intentId" || v === null || v === undefined) continue;
      console.log(`    ${k.padEnd(18)}${String(v)}`);
    }
    console.log(
      `    releasable        ${release.ok ? "yes" : "NO"} (${release.why})`,
    );
    if (row.state === "MANUAL_REVIEW") {
      console.log(
        "    \x1b[31mThis gate may have spent. Check the Solana signature and the provider before\x1b[0m",
      );
      console.log("    \x1b[31mconcluding anything. Do not re-arm the same scope.\x1b[0m");
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(`gate status failed: ${(e as Error).message}`);
  process.exit(1);
});
