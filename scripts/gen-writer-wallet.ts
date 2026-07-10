import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Generate the receipt-writer's signing wallet — the key the WORKER uses to send `logReceipts` and
 * the address the admin authorizes as a writer through the timelock. Fresh burner, testnet-only.
 *
 * The private key is written ONLY to packages/receipt-writer/.env (gitignored) and echoed to stdout
 * once; the public address is what you hand to `provision-receipt-writer.ts` (WRITER_ADDRESS) and
 * fund from the X Layer testnet faucet. This script never touches the chain.
 */

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", "packages", "receipt-writer", ".env");
const FAUCET = "https://www.okx.com/xlayer/faucet";

function existingKey(): `0x${string}` | undefined {
  const fromEnv = process.env.WRITER_PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv as `0x${string}`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("WRITER_PRIVATE_KEY="));
    const val = line?.slice("WRITER_PRIVATE_KEY=".length).trim();
    if (val) return val as `0x${string}`;
  }
  return undefined;
}

function banner(address: `0x${string}`, reused: boolean): void {
  console.log("");
  console.log("========================================================================");
  console.log(reused ? " RECEIPT-WRITER WALLET (already provisioned)" : " RECEIPT-WRITER WALLET GENERATED (fresh burner)");
  console.log("========================================================================");
  console.log(` Public address : ${address}`);
  console.log(` Private key    : packages/receipt-writer/.env (gitignored) — burner, testnet only`);
  console.log("");
  console.log(" NEXT STEPS:");
  console.log(`   1. Fund this address with testnet OKB for gas: ${FAUCET}`);
  console.log(`   2. Provision it as an authorized writer (admin runs, with the admin key set):`);
  console.log(`        DEPLOYER_PRIVATE_KEY=0x<admin> WRITER_ADDRESS=${address} \\`);
  console.log(`        BROADCAST=1 pnpm tsx scripts/provision-receipt-writer.ts`);
  console.log(`   3. Set WRITER_PRIVATE_KEY on the worker service (Railway) from the .env above.`);
  console.log("========================================================================");
  console.log("");
}

const reused = existingKey();
if (reused) {
  banner(privateKeyToAccount(reused).address, true);
  console.log("WRITER_PRIVATE_KEY already present — not overwriting.");
} else {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const header = existsSync(envPath)
    ? ""
    : "# receipt-writer worker secrets — gitignored, never commit\n";
  appendFileSync(envPath, `${header}WRITER_PRIVATE_KEY=${key}\n`);
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // best-effort permission tightening
  }
  banner(address, false);
  console.log("Wrote WRITER_PRIVATE_KEY to packages/receipt-writer/.env (gitignored).");
}
