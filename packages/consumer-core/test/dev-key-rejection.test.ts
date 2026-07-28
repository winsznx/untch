import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isWellKnownDevKey, loadRailKeys, loadSiwxKey } from "../src/index";

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
