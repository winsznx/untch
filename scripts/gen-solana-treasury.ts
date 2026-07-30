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

/**
 * The runtime variable. Setting this in Railway is what gives the Solana rail a signer.
 */
const TREASURY_ENV_VAR = "CONSUMER_TREASURY_SOLANA_SECRET_KEY";

/**
 * The rotation variables, used by `--proof`.
 *
 * The secret is stored locally under a name the RUNTIME DOES NOT READ. That is the point of the second
 * name rather than an accident of it: after the 2026-07-29 incident the replacement key has to exist
 * locally, be fundable, and be verifiable by preflight, all without any chance that its mere presence in
 * an environment arms the rail. Promoting it is a deliberate, separate act of copying it into
 * CONSUMER_TREASURY_SOLANA_SECRET_KEY in Railway, after preflight passes.
 *
 * The address is stored too, because the preflight asserts the rotated wallet by address. A preflight
 * that merely found some funded Solana account would pass against the very key being retired.
 */
const PROOF_SECRET_ENV_VAR = "CONSUMER_SOLANA_PROOF_SECRET_KEY";
const PROOF_ADDRESS_ENV_VAR = "CONSUMER_SOLANA_PROOF_TREASURY_ADDRESS";

/**
 * The reserve variables, used by `--reserve`.
 *
 * A custody wallet, deliberately not a treasury. It holds the Consumer Pack float that no proof needs,
 * so that the wallet which DOES get an execution flag holds only the bounded amount that proof can
 * lose. Splitting them is the whole point: a single wallet holding both the float and the execution
 * authority makes the blast radius of any arming mistake the entire balance.
 *
 * Neither name is read by the runtime, and neither ever belongs in Railway. Nothing in production has a
 * reason to spend from the reserve, so nothing in production is given the means to.
 */
const RESERVE_SECRET_ENV_VAR = "CONSUMER_SOLANA_RESERVE_SECRET_KEY";
const RESERVE_ADDRESS_ENV_VAR = "CONSUMER_SOLANA_RESERVE_ADDRESS";

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
  /**
   * Rotation mode, for replacing a key that has to be treated as compromised.
   *
   * It differs from a first-time generation in exactly one way that matters: the output is stored under
   * a name the runtime ignores, so a rotated key cannot arm anything until someone deliberately promotes
   * it. Everything else, including the refusal to print the secret, is shared.
   */
  const proof = process.argv.includes("--proof");
  /**
   * Reserve mode, for the custody wallet that holds the float no proof needs.
   *
   * Same refusal to print, same non-runtime storage name. It differs from `--proof` only in intent, and
   * the intent is worth a separate flag: the reserve must never be confused with the wallet that gets an
   * execution flag, and two flags cannot be mixed up as easily as one flag and a comment.
   */
  const reserve = process.argv.includes("--reserve");
  if (proof && reserve) {
    console.error("\x1b[31m--proof and --reserve are different wallets. Pass one.\x1b[0m");
    process.exit(1);
  }
  const envVar = proof ? PROOF_SECRET_ENV_VAR : reserve ? RESERVE_SECRET_ENV_VAR : TREASURY_ENV_VAR;

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

  const title = proof
    ? "Solana PROOF signer (rotated)"
    : reserve
      ? "Solana RESERVE wallet (custody only)"
      : "Solana settlement treasury";
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log(`  address       ${generated.address}`);
  console.log(`  key format    base58, 64 bytes (32-byte seed + 32-byte public key)`);
  console.log(`  explorer      https://solscan.io/account/${generated.address}`);
  if (proof || reserve) {
    console.log(`  stored as     ${envVar} (the runtime does NOT read this name)`);
  }
  if (reserve) {
    console.log("  role          custody only. Never armed, never in Railway, never given to a worker.");
  }

  const envPath = join(process.cwd(), ".env");

  if (!write) {
    console.log("\n  The secret was NOT printed and NOT written.");
    console.log(`  Re-run with --write to append ${envVar} to .env, or set it in Railway by hand.`);
    console.log("\n  \x1b[33mNothing spends from this wallet yet.\x1b[0m Execution stays off until");
    console.log("  CONSUMER_PROVIDER_PURCH_ENABLED and the Solana chain flag are both set, and the");
    console.log("  rail's pay() is still PROTOCOL_NOT_EXECUTABLE by design.");
    return;
  }

  if (existsSync(envPath) && readFileSync(envPath, "utf8").includes(`${envVar}=`)) {
    console.error(
      `\n\x1b[31m${envVar} is already present in .env. Refusing to append a second one —\x1b[0m` +
        "\nremove the existing line first if you really mean to rotate the treasury.",
    );
    process.exit(1);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  appendFileSync(
    envPath,
    proof
      ? `\n# Solana PROOF signer, rotated ${stamp}. Address ${generated.address}\n` +
          `# Replaces a treasury key that was exposed to a service with broader authority than intended.\n` +
          `# The runtime does NOT read ${PROOF_SECRET_ENV_VAR}. Promoting it to\n` +
          `# ${TREASURY_ENV_VAR} in Railway is a separate, deliberate step, taken only after\n` +
          `# \`pnpm solana:proof:preflight\` passes.\n` +
          `${PROOF_SECRET_ENV_VAR}=${generated.secretBase58}\n` +
          `${PROOF_ADDRESS_ENV_VAR}=${generated.address}\n`
      : reserve
        ? `\n# Solana RESERVE wallet, generated ${stamp}. Address ${generated.address}\n` +
            `# Custody only. Holds the Consumer Pack float that no proof needs, so the wallet that DOES\n` +
            `# get an execution flag holds only what that proof can lose.\n` +
            `# The runtime does NOT read ${RESERVE_SECRET_ENV_VAR}, and it never belongs in Railway.\n` +
            `${RESERVE_SECRET_ENV_VAR}=${generated.secretBase58}\n` +
            `${RESERVE_ADDRESS_ENV_VAR}=${generated.address}\n`
        : `\n# Solana settlement treasury, generated ${stamp}. Address ${generated.address}\n` +
            `${TREASURY_ENV_VAR}=${generated.secretBase58}\n`,
  );
  console.log(`\n  \x1b[32m✓\x1b[0m secret appended to .env (gitignored). It was not printed.`);

  if (proof) {
    console.log(`  \x1b[32m✓\x1b[0m ${PROOF_ADDRESS_ENV_VAR} written, so preflight can assert this wallet.`);
    console.log("\n  Next, in this order:");
    console.log(`    1. Fund ${generated.address} with 0.050000 USDC and 0.010000 SOL.`);
    console.log("    2. Run `pnpm solana:proof:preflight` and get a PASS.");
    console.log(`    3. ONLY THEN copy the secret into ${TREASURY_ENV_VAR} in Railway.`);
    console.log("\n  \x1b[33mThe old treasury key must never be restored to Railway.\x1b[0m");
    return;
  }

  if (reserve) {
    console.log(`  \x1b[32m✓\x1b[0m ${RESERVE_ADDRESS_ENV_VAR} written.`);
    console.log("\n  \x1b[33mThis wallet is custody only.\x1b[0m Do not put it in Railway, do not give it to a");
    console.log("  worker, and do not use it as a settlement treasury.");
    return;
  }

  console.log("\n  Next:");
  console.log("    1. Fund the address with USDC and a little SOL (see `pnpm purch:funding`).");
  console.log("    2. Set the same variable in Railway. Do not copy it through a terminal you do");
  console.log("       not control.");
  console.log("    3. Leave CONSUMER_PROVIDER_PURCH_ENABLED off until the rail passes live");
  console.log("       read-only verification.");

  void randomBytes;
}

main();
