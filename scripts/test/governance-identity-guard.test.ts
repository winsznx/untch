import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { keccak256, encodeAbiParameters } from "viem";

/**
 * The 2026-07-30 incident, as tests.
 *
 * A timelocked `ADD_WRITER` executed exactly as approved — opId, kind, target and eta all verified
 * against chain — and authorised the wrong account. Two failures compounded:
 *
 *   1. The approved target came from the ASP's `MAINNET_WRITER_ADDRESS`, the SpendIntentRegistry
 *      writer, and nothing compared it to the key `untch-receipt-writer` actually signs with.
 *   2. The CORRECT operation was already pending for the anchorer's real address, and went unseen
 *      because the check looked up one opId instead of enumerating the board.
 *
 * Every test here fails against a guard that lacks the corresponding protection.
 */

const REPO = resolve(import.meta.dirname, "../..");
const GUARD = resolve(REPO, "scripts/governance-identity-guard.ts");
const REDRIVE = resolve(REPO, "scripts/receipt-redrive.ts");

/** The two addresses at the centre of the incident. */
const ANCHOR_SIGNER = "0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5";
const INTENT_SIGNER = "0xeeDda7D18A34A93F3A722eb4446A526Af515457A";

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(script: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: REPO,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

describe("the guard demands the five facts whose absence caused the incident", () => {
  /**
   * Each argument closes one route to the same mistake, so each is tested separately.
   *
   * A guard that accepted any of them as optional would let the caller ask the ambiguous question
   * again: "what is the writer address" has more than one true answer, and that is the whole problem.
   */
  test("it refuses without an explicit service name", async () => {
    const r = await run(GUARD, ["--key-var", "WRITER_PRIVATE_KEY", "--expect", ANCHOR_SIGNER, "--contract", "UntchReceipts", "--role", "ADD_WRITER"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--service is required/);
  });

  test("it refuses without an explicit key variable", async () => {
    const r = await run(GUARD, ["--service", "untch-receipt-writer", "--expect", ANCHOR_SIGNER, "--contract", "UntchReceipts", "--role", "ADD_WRITER"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--key-var is required/);
  });

  test("it refuses without an expected address to contradict", async () => {
    const r = await run(GUARD, ["--service", "untch-receipt-writer", "--key-var", "WRITER_PRIVATE_KEY", "--contract", "UntchReceipts", "--role", "ADD_WRITER"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--expect is required/);
  });

  test("it refuses without an explicit target contract", async () => {
    const r = await run(GUARD, ["--service", "untch-receipt-writer", "--key-var", "WRITER_PRIVATE_KEY", "--expect", ANCHOR_SIGNER, "--role", "ADD_WRITER"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--contract is required/);
  });

  test("it refuses without an explicit intended role", async () => {
    const r = await run(GUARD, ["--service", "untch-receipt-writer", "--key-var", "WRITER_PRIVATE_KEY", "--expect", ANCHOR_SIGNER, "--contract", "UntchReceipts"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--role is required/);
  });

  /**
   * The purest form of the mistake: naming the variable the wrong address came from.
   *
   * `MAINNET_WRITER_ADDRESS` is a real variable holding a real address that is genuinely a writer —
   * just not this service's. A guard that accepted it would reproduce the incident verbatim.
   */
  test("it refuses an environment variable NAME where an address belongs", async () => {
    const r = await run(GUARD, [
      "--service", "untch-receipt-writer", "--key-var", "WRITER_PRIVATE_KEY",
      "--expect", "MAINNET_WRITER_ADDRESS", "--contract", "UntchReceipts", "--role", "ADD_WRITER",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not the name of an environment variable/);
    assert.match(r.stderr, /authorised the wrong account/);
  });

  test("it refuses a service and key variable that do not belong together", async () => {
    // The ASP does not sign receipts with WRITER_PRIVATE_KEY, and pairing them is a category error.
    const r = await run(GUARD, [
      "--service", "untch-asp", "--key-var", "WRITER_PRIVATE_KEY",
      "--expect", ANCHOR_SIGNER, "--contract", "UntchReceipts", "--role", "ADD_WRITER",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /does not sign with WRITER_PRIVATE_KEY/);
  });

  test("it refuses a service it has no recorded signing path for", async () => {
    const r = await run(GUARD, [
      "--service", "some-other-service", "--key-var", "WRITER_PRIVATE_KEY",
      "--expect", ANCHOR_SIGNER, "--contract", "UntchReceipts", "--role", "ADD_WRITER",
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /does not sign with|no recorded signing call path/);
  });
});

/**
 * The call-path check reads SOURCE, not a description of it.
 *
 * A guard that trusted a hardcoded sentence about how a service signs would keep passing after the
 * service stopped signing that way — which is the same class of staleness as the address itself.
 */
describe("the recorded signing paths still match the source", () => {
  const guardSrc = readFileSync(GUARD, "utf8");

  test("the receipt writer still derives its account and calls logReceipts", () => {
    const chain = readFileSync(resolve(REPO, "packages/receipt-writer/src/chain.ts"), "utf8");
    assert.ok(chain.includes("privateKeyToAccount(opts.writerPrivateKey)"), "the signer derivation moved");
    assert.ok(chain.includes('functionName: "logReceipts"'), "the anchoring call moved");
  });

  test("the guard asserts those exact strings, so a move breaks it loudly", () => {
    assert.ok(guardSrc.includes("privateKeyToAccount(opts.writerPrivateKey)"));
    assert.ok(guardSrc.includes('functionName: \\"logReceipts\\"') || guardSrc.includes('logReceipts'));
  });

  test("the guard signs nothing", () => {
    for (const banned of ["writeContract", "createWalletClient", "sendTransaction", "propose(", "execute("]) {
      assert.equal(guardSrc.includes(banned), false, `a guard that can ${banned} will be trusted for its check and run for its action`);
    }
  });
});

/**
 * The opId derivation, which is what makes enumeration possible at all.
 *
 * `abi.encode` keeps the enum and the address in separate 32-byte words, so no two (kind, target)
 * pairs can collide — the property the whole board relies on.
 */
describe("operation ids are derived the way the contract derives them", () => {
  const opIdOf = (kind: number, target: string): string =>
    keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [kind, target as `0x${string}`]));

  test("the two incident operations have the ids observed on chain", () => {
    // ADD_WRITER for the address that was wrongly authorised.
    assert.equal(opIdOf(1, INTENT_SIGNER), "0x3380bfff55aebbc029d1a0ba6bb62df6797165a9150eadca76242b283f22e4b3");
    // ADD_WRITER for the anchorer — the operation that was already pending and went unseen.
    assert.equal(opIdOf(1, ANCHOR_SIGNER), "0xb4d6ce980c9c18a1d08e23abafa972cd4d82b78a0fc2e27935f7ced80ed4ddfa");
    // REMOVE_WRITER, scheduled to withdraw the unintended grant.
    assert.equal(opIdOf(2, INTENT_SIGNER), "0x7fa2f2d0a3ad599fc82ae82c04569bb4e47b8251f545f3517d80222117351704");
  });

  test("the same target under different kinds never collides", () => {
    const ids = new Set([opIdOf(1, INTENT_SIGNER), opIdOf(2, INTENT_SIGNER), opIdOf(3, INTENT_SIGNER)]);
    assert.equal(ids.size, 3);
  });

  test("the two signers are different addresses, which is the fact the incident missed", () => {
    assert.notEqual(ANCHOR_SIGNER.toLowerCase(), INTENT_SIGNER.toLowerCase());
    assert.notEqual(opIdOf(1, ANCHOR_SIGNER), opIdOf(1, INTENT_SIGNER));
  });
});

/**
 * The redrive's blast radius.
 *
 * It used to re-drive every degraded batch. An operator reaching for it to re-drive ONE approved batch
 * would have moved six and submitted anchor transactions for five nobody named.
 */
describe("receipt-redrive cannot mutate more than it was told to", () => {
  test("--apply without --batch is refused, and the reason names the danger", async () => {
    const r = await run(REDRIVE, ["--apply"], { PGURL: "postgresql://unused@127.0.0.1:1/none" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--apply requires --batch/);
    assert.match(r.stderr, /batches nobody named/);
  });

  test("a non-numeric batch id is refused before any connection", async () => {
    const r = await run(REDRIVE, ["--batch", "twenty-seven", "--apply"], { PGURL: "postgresql://unused@127.0.0.1:1/none" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--batch must be a positive integer/);
  });

  test("the source contains no path that applies to every degraded batch", () => {
    const src = readFileSync(REDRIVE, "utf8");
    // The old shape: a loop calling redriveDegraded over the whole degraded list.
    assert.equal(
      /for\s*\(const\s+b\s+of\s+degraded\)\s*\{[^}]*redriveDegraded/.test(src),
      false,
      "a loop over every degraded batch has returned",
    );
    assert.ok(src.includes("--apply requires --batch"), "the refusal must be present");
  });
});
