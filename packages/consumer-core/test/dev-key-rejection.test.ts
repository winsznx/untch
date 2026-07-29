import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isWellKnownDevKey,
  loadRailKeys,
  loadSiwxKey,
  checkSolanaSecretKey,
  decodeBase58,
  encodeBase58,
  solanaMintAllowlist,
  SOLANA_USDC_MINT,
} from "../src/index";

/**
 * Published development keys must never reach a treasury.
 *
 * GitGuardian flags `0x59c6995e…690d` in this repository. It is the Anvil/Hardhat default account #1
 * key — published in those tools' documentation and spendable by anyone on earth. Here it appears
 * only in local-fork scripts and test fixtures, so the finding is a true positive by shape and a
 * false positive by risk.
 *
 * "By risk" was an assertion until these tests existed. Shape validation cannot catch a published
 * key: it is a perfectly well-formed 32 bytes. The realistic failure is mundane — someone copies a
 * key out of a soak script into a `.env` while debugging and it survives into a deployment. These
 * tests are what make the claim checkable rather than merely stated.
 */

const ANVIL_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** Well-formed, and not one of the published defaults. */
const REAL_SHAPED = `0x${"1a".repeat(32)}`;

describe("published development keys are rejected", () => {
  test("the exact key GitGuardian flags is recognised", () => {
    assert.equal(isWellKnownDevKey(ANVIL_1), true);
  });

  test("recognition is case-insensitive and whitespace-tolerant", () => {
    // A key pasted out of a terminal arrives with a newline more often than not.
    assert.equal(isWellKnownDevKey(`  ${ANVIL_1.toUpperCase().replace("0X", "0x")}\n`), true);
  });

  test("the whole default account set is covered, not just account #1", () => {
    assert.equal(isWellKnownDevKey(ANVIL_0), true);
  });

  test("a real-shaped key is NOT rejected", () => {
    // If this ever failed, the guard would be refusing legitimate keys and would be turned off.
    assert.equal(isWellKnownDevKey(REAL_SHAPED), false);
  });

  test("the Base treasury loader refuses it, and says why", () => {
    assert.throws(
      () => loadRailKeys({ CONSUMER_TREASURY_BASE_PRIVATE_KEY: ANVIL_1 } as NodeJS.ProcessEnv),
      /PUBLISHED development key/,
      "a published key must never become a settlement signer",
    );
  });

  test("the Tempo treasury loader refuses it", () => {
    assert.throws(
      () => loadRailKeys({ CONSUMER_TREASURY_TEMPO_PRIVATE_KEY: ANVIL_1 } as NodeJS.ProcessEnv),
      /PUBLISHED development key/,
    );
  });

  test("the SIWX identity loader refuses it", () => {
    // It holds no funds, but it proves WHO IS ASKING — a published identity key is worse than none.
    assert.throws(
      () => loadSiwxKey({ CONSUMER_SIWX_PRIVATE_KEY: ANVIL_1 } as NodeJS.ProcessEnv),
      /PUBLISHED development key/,
    );
  });

  test("rejection applies in EVERY environment, not only production", () => {
    // A dev-only escape hatch is exactly the flag someone sets in production during an incident.
    for (const nodeEnv of ["development", "test", "production", undefined]) {
      assert.throws(
        () =>
          loadRailKeys({
            CONSUMER_TREASURY_BASE_PRIVATE_KEY: ANVIL_1,
            ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
          } as NodeJS.ProcessEnv),
        /PUBLISHED development key/,
        `must reject under NODE_ENV=${nodeEnv ?? "(unset)"}`,
      );
    }
  });

  test("a legitimate key still loads", () => {
    const keys = loadRailKeys({ CONSUMER_TREASURY_BASE_PRIVATE_KEY: REAL_SHAPED } as NodeJS.ProcessEnv);
    assert.equal(keys.base?.secret, REAL_SHAPED);
  });

  test("a malformed key is still refused by shape, with the older message", () => {
    assert.throws(
      () => loadRailKeys({ CONSUMER_TREASURY_BASE_PRIVATE_KEY: "0xnope" } as NodeJS.ProcessEnv),
      /not a valid 0x 32-byte private key/,
    );
  });
});

describe("Solana treasury keys — shape, and the published ones", () => {
  // A valid 64-byte keypair: a non-trivial seed followed by 32 more bytes. Its cryptographic
  // correctness is irrelevant here; what is under test is the loader's refusal logic.
  const seed = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfe", "hex");
  const pub = Buffer.from("11".repeat(32), "hex");
  const goodKeypair = encodeBase58(new Uint8Array(Buffer.concat([seed, pub])));

  test("a well-formed base58 keypair is accepted and yields its public address", () => {
    const check = checkSolanaSecretKey(goodKeypair);
    assert.equal(check.ok, true, check.reason);
    assert.equal(check.address, encodeBase58(new Uint8Array(pub)));
  });

  test("a JSON keypair array is accepted — it is what a keypair file holds", () => {
    const check = checkSolanaSecretKey(JSON.stringify([...seed, ...pub]));
    assert.equal(check.ok, true, check.reason);
  });

  test("an EVM private key is refused rather than silently truncated", () => {
    const check = checkSolanaSecretKey("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    assert.equal(check.ok, false);
    assert.match(check.reason, /base58/);
  });

  test("a key of the wrong length is refused with the length it had", () => {
    const check = checkSolanaSecretKey(encodeBase58(new Uint8Array(seed)));
    assert.equal(check.ok, false);
    assert.match(check.reason, /64-byte keypair/);
  });

  test("a PUBLISHED development seed is refused however it is encoded", () => {
    // #given the all-zero seed, which is what a broken generator produces
    const zeroSeed = Buffer.alloc(32, 0);
    const asBase58 = encodeBase58(new Uint8Array(Buffer.concat([zeroSeed, pub])));
    const asJson = JSON.stringify([...zeroSeed, ...pub]);
    // #then both encodings are refused, because the check is on the seed
    assert.equal(checkSolanaSecretKey(asBase58).ok, false);
    assert.match(checkSolanaSecretKey(asBase58).reason, /PUBLISHED development seed/);
    assert.equal(checkSolanaSecretKey(asJson).ok, false);
  });

  test("loadRailKeys refuses to boot with an unusable Solana key", () => {
    assert.throws(
      () => loadRailKeys({ CONSUMER_TREASURY_SOLANA_SECRET_KEY: "not-a-key" } as NodeJS.ProcessEnv),
      /CONSUMER_TREASURY_SOLANA_SECRET_KEY is unusable/,
    );
  });

  test("an absent Solana key is a rail that is off, not an error", () => {
    const keys = loadRailKeys({} as NodeJS.ProcessEnv);
    assert.equal(keys.solana, null);
  });

  test("the mint allowlist always contains USDC and never trusts a symbol", () => {
    const allow = solanaMintAllowlist({} as NodeJS.ProcessEnv);
    assert.ok(allow.includes(SOLANA_USDC_MINT));
    // A token's on-chain identity IS its mint. Anyone can mint something whose metadata says USDC,
    // so the allowlist must never be keyed on a symbol.
    assert.equal(allow.length, 1);
  });

  test("base58 round-trips, including leading zero bytes", () => {
    const withLeadingZeros = new Uint8Array([0, 0, 7, 42, 255]);
    assert.deepEqual(decodeBase58(encodeBase58(withLeadingZeros)), withLeadingZeros);
  });
});
