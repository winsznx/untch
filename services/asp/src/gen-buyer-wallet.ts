import { appendFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORK, PROOF_OF_RAIL_PRICE, SETTLEMENT_TOKEN } from "./config";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

function existingKey(): `0x${string}` | undefined {
  const fromEnv = process.env.BUYER_PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv as `0x${string}`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("BUYER_PRIVATE_KEY="));
    const val = line?.slice("BUYER_PRIVATE_KEY=".length).trim();
    if (val) return val as `0x${string}`;
  }
  return undefined;
}

function printFundingInstructions(address: `0x${string}`, reused: boolean): void {
  const t = SETTLEMENT_TOKEN;
  console.log("");
  console.log("========================================================================");
  console.log(reused ? " BUYER WALLET (already provisioned)" : " BUYER WALLET GENERATED (fresh burner)");
  console.log("========================================================================");
  console.log(` Public address : ${address}`);
  console.log(` Private key    : saved to services/asp/.env (gitignored) — burner, do NOT reuse`);
  console.log("");
  console.log(" FUND THIS WALLET BEFORE THE PAID CALL CAN SETTLE:");
  console.log(`   Token   : ${t.symbol} (${t.address})`);
  console.log(`   Amount  : at least ${PROOF_OF_RAIL_PRICE} — send ~$0.05 worth to cover one call + margin`);
  console.log(`   Network : X Layer Mainnet (${NETWORK}, chainId 196)`);
  console.log(`   Gas     : none needed on the buyer — EIP-3009 transferWithAuthorization is`);
  console.log(`             gasless for the signer; the facilitator submits + pays gas.`);
  console.log("========================================================================");
  console.log("");
}

const reused = existingKey();
if (reused) {
  printFundingInstructions(privateKeyToAccount(reused).address, true);
  console.log("BUYER_PRIVATE_KEY already present — not overwriting.");
} else {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const header = existsSync(envPath) ? "" : "# services/asp local secrets — gitignored, never commit\n";
  appendFileSync(envPath, `${header}BUYER_PRIVATE_KEY=${key}\n`);
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // best-effort permission tightening; non-fatal on filesystems that reject chmod
  }
  printFundingInstructions(address, false);
  console.log("Wrote BUYER_PRIVATE_KEY to services/asp/.env (gitignored). Fund the address above, then run `pnpm pay`.");
}
