import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, type Address, type Hex } from "viem";
import { hashSpendIntent, type SpendIntent } from "../src/spendIntent";
import { canonUint256 } from "../src/domain";

/**
 * Surface B — SpendIntent struct hash (§8.1). These unit tests pin the encoding independently
 * of the Solidity differential, and the final block re-derives every committed fixture hash so
 * `pnpm test:canon` alone proves the TS side matches `fixtures/intents.hashes.json`.
 */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_B32 = `0x${"0".repeat(64)}` as Hex;

function intent(overrides: Partial<SpendIntent> = {}): SpendIntent {
  return {
    owner: ZERO_ADDR,
    buyerAgentId: 0n,
    workerAgentId: 0n,
    token: ZERO_ADDR,
    maxAmount: 0n,
    taskHash: ZERO_B32,
    acceptanceHash: ZERO_B32,
    schemaHash: ZERO_B32,
    policyHash: ZERO_B32,
    deadline: 0n,
    nonce: 0n,
    ...overrides,
  };
}

describe("Surface B: hashSpendIntent (§8.1)", () => {
  test("all-zero intent == keccak256(352 zero bytes) — the abi.encode layout is 11x32 bytes", () => {
    assert.equal(hashSpendIntent(intent()), keccak256(new Uint8Array(11 * 32)));
  });

  test("address case does not affect the hash (abi.encode is case-insensitive on address)", () => {
    const lower = intent({ owner: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" });
    const checksummed = intent({ owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address });
    assert.equal(hashSpendIntent(lower), hashSpendIntent(checksummed));
  });

  test("distinct fields are not interchangeable (field identity matters)", () => {
    const a = intent({ buyerAgentId: 1n, workerAgentId: 2n });
    const b = intent({ buyerAgentId: 2n, workerAgentId: 1n });
    assert.notEqual(hashSpendIntent(a), hashSpendIntent(b));
  });

  test("a single-bit change in any field changes the hash", () => {
    const base = hashSpendIntent(intent());
    assert.notEqual(hashSpendIntent(intent({ nonce: 1n })), base);
    assert.notEqual(hashSpendIntent(intent({ deadline: 1n })), base);
    assert.notEqual(hashSpendIntent(intent({ maxAmount: 1n })), base);
    assert.notEqual(
      hashSpendIntent(intent({ taskHash: `0x${"0".repeat(63)}1` as Hex })),
      base,
    );
  });
});

describe("Surface B: reproduces the committed fixture corpus", () => {
  interface RawCase {
    name: string;
    owner: string;
    buyerAgentId: string;
    workerAgentId: string;
    token: string;
    maxAmount: string;
    taskHash: string;
    acceptanceHash: string;
    schemaHash: string;
    policyHash: string;
    deadline: string;
    nonce: string;
  }

  const corpus = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../fixtures/intents.json", import.meta.url)), "utf8"),
  ) as { count: number; cases: RawCase[] };
  const committed = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../fixtures/intents.hashes.json", import.meta.url)),
      "utf8",
    ),
  ) as { count: number; hashes: { name: string; hash: Hex }[] };

  test("fixture files agree on count and ordering", () => {
    assert.equal(corpus.count, corpus.cases.length);
    assert.equal(committed.count, committed.hashes.length);
    assert.equal(corpus.count, committed.count);
    assert.ok(corpus.count >= 8, "D0.5 requires >=8 cases");
  });

  for (let i = 0; i < corpus.cases.length; i++) {
    const c = corpus.cases[i]!;
    test(`fixture "${c.name}" reproduces the committed hash`, () => {
      const computed = hashSpendIntent({
        owner: c.owner as Address,
        buyerAgentId: BigInt(canonUint256(c.buyerAgentId)),
        workerAgentId: BigInt(canonUint256(c.workerAgentId)),
        token: c.token as Address,
        maxAmount: BigInt(canonUint256(c.maxAmount)),
        taskHash: c.taskHash as Hex,
        acceptanceHash: c.acceptanceHash as Hex,
        schemaHash: c.schemaHash as Hex,
        policyHash: c.policyHash as Hex,
        deadline: BigInt(canonUint256(c.deadline)),
        nonce: BigInt(canonUint256(c.nonce)),
      });
      const expected = committed.hashes[i]!;
      assert.equal(expected.name, c.name, "corpus/hashes ordering drift");
      assert.equal(computed, expected.hash);
    });
  }
});
