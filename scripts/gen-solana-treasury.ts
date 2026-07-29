/**
 * Generate the dedicated Solana settlement treasury.
 *
 *   pnpm gen:solana-treasury            # print the public address and the env line to add
 *   pnpm gen:solana-treasury --write    # append it to .env, which is gitignored
 *
 * WHAT THIS FILE WILL NOT DO
 *
 * Print the secret to the terminal. `--write` appends it straight to `.env` and reports only the
 * public address, because a secret echoed to a terminal is a secret in a scrollback buffer, a
 * screen recording and a shell history file. The only way to see it is to open the file it was
 * written to, which is the same posture every other Untch key has.
 *
 * WHY A DEDICATED WALLET
 *
 * Purch settles only on Solana, and the treasury that pays it must be separate from every EVM
 * treasury for the reason all the others are separate: a key that can only lose one rail's float is
 * a smaller loss than a key that can lose all of them. It is also separate from any personal wallet,
 * which this script enforces the only way it can, by generating a fresh one rather than accepting an
 * existing key.
 *
 * The keypair is ed25519 through Node's own crypto, so nothing new enters the dependency tree. A
 * Solana keypair is exactly a 32-byte seed followed by its 32-byte public key, and both come out of
 * the standard DER exports.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSolanaSecretKey, encodeBase58 } from "../packages/consumer-core/src/index";

const ENV_VAR = "CONSUMER_TREASURY_SOLANA_SECRET_KEY";

interface Generated {
  readonly address: string;
  readonly secretBase58: string;
}

/**
 * A Solana keypair from Node's ed25519.
 *
 * `solana-keygen` writes 64 bytes: the 32-byte seed then the 32-byte public key. Node exports the
 * seed inside a PKCS#8 wrapper and the public key inside SPKI, and in both cases the raw 32 bytes
 * are the tail. Taking the tail is exact rather than approximate: ed25519 keys are fixed-length, so
 * the DER prefix is a constant and the last 32 bytes are always the key material.
 */
function generate(): Generated {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);

  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);

  return { address: encodeBase58(pub), secretBase58: encodeBase58(secret) };
}

function main(): void {
  const write = process.argv.includes("--write");

  const generated = generate();

  // Validate what we just produced with the SAME validator the loader uses. A generator whose output
  // its own loader rejects is a failure worth finding here, in a script that has printed nothing,
  // rather than at boot in production.
  const check = checkSolanaSecretKey(generated.secretBase58);
  if (!check.ok) {
    console.error(`\x1b[31mgenerated key failed validation: ${check.reason}\x1b[0m`);
    process.exit(1);
  }
  if (check.address !== generated.address) {
    console.error("\x1b[31mthe validator derived a different address than the generator. Refusing.\x1b[0m");
    process.exit(1);
  }

  console.log("\n\x1b[1mSolana settlement treasury\x1b[0m");
  console.log(`  address       ${generated.address}`);
  console.log(`  key format    base58, 64 bytes (32-byte seed + 32-byte public key)`);
  console.log(`  explorer      https://solscan.io/account/${generated.address}`);

  const envPath = join(process.cwd(), ".env");

  if (!write) {
    console.log("\n  The secret was NOT printed and NOT written.");
    console.log(`  Re-run with --write to append ${ENV_VAR} to .env, or set it in Railway by hand.`);
    console.log("\n  \x1b[33mNothing spends from this wallet yet.\x1b[0m Execution stays off until");
    console.log("  CONSUMER_PROVIDER_PURCH_ENABLED and the Solana chain flag are both set, and the");
    console.log("  rail's pay() is still PROTOCOL_NOT_EXECUTABLE by design.");
    return;
  }

  if (existsSync(envPath) && readFileSync(envPath, "utf8").includes(`${ENV_VAR}=`)) {
    console.error(
      `\n\x1b[31m${ENV_VAR} is already present in .env. Refusing to append a second one —\x1b[0m` +
        "\nremove the existing line first if you really mean to rotate the treasury.",
    );
    process.exit(1);
  }

  appendFileSync(
    envPath,
    `\n# Solana settlement treasury, generated ${new Date().toISOString().slice(0, 10)}. Address ${generated.address}\n` +
      `${ENV_VAR}=${generated.secretBase58}\n`,
  );
  console.log(`\n  \x1b[32m✓\x1b[0m secret appended to .env (gitignored). It was not printed.`);
  console.log("\n  Next:");
  console.log("    1. Fund the address with USDC and a little SOL (see `pnpm purch:funding`).");
  console.log("    2. Set the same variable in Railway. Do not copy it through a terminal you do");
  console.log("       not control.");
  console.log("    3. Leave CONSUMER_PROVIDER_PURCH_ENABLED off until the rail passes live");
  console.log("       read-only verification.");

  void randomBytes;
}

main();
