import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xLayerTestnet, X_LAYER_TESTNET_ID } from "../packages/shared/src/chains";
import { OP_KIND, UNTCH_RECEIPTS_ABI } from "../packages/receipt-writer/src/abi";
import { RECEIPTS_CONTRACT_DEFAULT } from "../packages/receipt-writer/src/config";

/**
 * Provision the receipt-writer as an authorized writer on the deployed UntchReceipts (§10.3), THROUGH
 * THE REAL ADMIN TIMELOCK, on X Layer testnet. This is the production writer-set change the §7.4
 * service depends on — a real testnet transaction sequence, not a simulation:
 *
 *   1. read on-chain: timelockDelay, admin, isWriter(writer). Idempotent — exits early if already a
 *      writer. Refuses to run unless the signer IS the admin, and refuses mainnet (chainId 196).
 *   2. propose(ADD_WRITER, writer) → records opId + eta = now + timelockDelay.
 *   3. prove execute() reverts BEFORE the delay via a read-only eth_call (no gas, no state change).
 *   4. wait the REAL delay (poll block.timestamp >= eta).
 *   5. execute(ADD_WRITER, writer).
 *   6. read back isWriter(writer) == true via raw eth_call — the proof is taken from chain state, not
 *      this script's own stdout.
 *
 * TIMELOCK-DELAY DECISION: this runs against the deployed testnet contract's IMMUTABLE 60s delay.
 * That value is kept deliberately for testnet (see packages/receipt-writer/docs/TIMELOCK-DELAY-
 * DECISION.md); a mainnet UntchReceipts must be deployed with a real hours-to-days delay, which is
 * why this script hard-refuses mainnet rather than provisioning against a short delay there.
 *
 * Env:
 *   RPC_URL               target RPC (default X Layer testnet).
 *   DEPLOYER_PRIVATE_KEY  the ADMIN key (0x98F43e…0b) — required to BROADCAST.
 *   WRITER_ADDRESS        the receipt-writer address to authorize (from gen-writer-wallet).
 *   RECEIPTS_CONTRACT     override the UntchReceipts address (defaults to the deployed testnet one).
 *   BROADCAST             "1" to send txs; anything else = preflight only.
 */

const RECEIPT_PATH = fileURLToPath(
  new URL("../contracts/deploy/receipt-writer-provisioning-receipt.json", import.meta.url),
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL?.trim() || xLayerTestnet.rpcUrls.default.http[0]!;
  const broadcast = process.env.BROADCAST === "1";
  const adminKey = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const writer = process.env.WRITER_ADDRESS?.trim() as Address | undefined;
  const contract = (process.env.RECEIPTS_CONTRACT?.trim() || RECEIPTS_CONTRACT_DEFAULT) as Address;

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();

  console.log("── receipt-writer provisioning (TESTNET ONLY) ──────────────────────────────");
  console.log(`RPC              : ${rpcUrl}`);
  console.log(`chainId          : ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""}`);
  console.log(`UntchReceipts    : ${contract}`);

  if (chainId === 196) {
    throw new Error("Refusing to run against X Layer MAINNET (196). Mainnet needs a real timelock delay.");
  }
  if (!writer || !isAddress(writer)) {
    throw new Error("WRITER_ADDRESS is required and must be a valid 0x address (run gen-writer-wallet).");
  }

  const call = { address: contract, abi: UNTCH_RECEIPTS_ABI } as const;
  const [timelockDelay, admin, alreadyWriter] = await Promise.all([
    pub.readContract({ ...call, functionName: "timelockDelay" }) as Promise<bigint>,
    pub.readContract({ ...call, functionName: "admin" }) as Promise<Address>,
    pub.readContract({ ...call, functionName: "isWriter", args: [writer] }) as Promise<boolean>,
  ]);
  console.log(`timelockDelay    : ${timelockDelay}s`);
  console.log(`admin            : ${admin}`);
  console.log(`writer target    : ${writer}`);
  console.log(`isWriter(writer) : ${alreadyWriter}`);

  if (alreadyWriter) {
    console.log("\n✓ writer is ALREADY authorized on-chain — nothing to do (idempotent).");
    return;
  }

  if (!adminKey) {
    console.log("\nNo DEPLOYER_PRIVATE_KEY set — preflight only. Set the ADMIN key + BROADCAST=1 to provision.");
    return;
  }

  const account = privateKeyToAccount(adminKey);
  if (account.address.toLowerCase() !== admin.toLowerCase()) {
    throw new Error(
      `signer ${account.address} is NOT the contract admin ${admin} — only the admin can provision writers.`,
    );
  }

  const balance = await pub.getBalance({ address: account.address });
  console.log(`admin balance    : ${formatEther(balance)} OKB`);
  if (balance === 0n) throw new Error("admin has 0 OKB — fund it for gas before provisioning.");

  if (!broadcast) {
    console.log("\nPreflight only (BROADCAST != 1). Not sending any transaction.");
    return;
  }

  const wallet = createWalletClient({ account, chain: xLayerTestnet, transport: http(rpcUrl) });
  const opId = (await pub.readContract({
    ...call,
    functionName: "opId",
    args: [OP_KIND.ADD_WRITER, writer],
  })) as Hex;

  // Guard: if an op is already pending for this (kind, target), skip straight to the wait/execute.
  let proposeHash: Hex | "reused-pending" = "reused-pending";
  const pendingEta = (await pub.readContract({ ...call, functionName: "opEta", args: [opId] })) as bigint;
  if (pendingEta === 0n) {
    console.log("\n[1/4] propose(ADD_WRITER, writer) — entering the timelock …");
    proposeHash = await wallet.writeContract({
      ...call,
      functionName: "propose",
      args: [OP_KIND.ADD_WRITER, writer],
    });
    await pub.waitForTransactionReceipt({ hash: proposeHash });
  } else {
    console.log("\n[1/4] an op is already pending for this writer — reusing it.");
  }
  const eta = (await pub.readContract({ ...call, functionName: "opEta", args: [opId] })) as bigint;
  console.log(`      opId ${opId}, eta ${eta}`);

  console.log("[2/4] proving execute() reverts BEFORE the delay (read-only eth_call) …");
  let earlyReverted = false;
  try {
    await pub.simulateContract({
      ...call,
      functionName: "execute",
      args: [OP_KIND.ADD_WRITER, writer],
      account: account.address,
    });
  } catch {
    earlyReverted = true;
  }
  console.log(`      execute-before-delay reverts: ${earlyReverted}`);
  if (!earlyReverted) throw new Error("TIMELOCK BROKEN: execute did not revert before the delay.");

  console.log(`[3/4] waiting out the real ${timelockDelay}s timelock delay …`);
  for (;;) {
    const block = await pub.getBlock();
    if (block.timestamp >= eta) break;
    const remaining = Number(eta - block.timestamp);
    console.log(`      block.timestamp ${block.timestamp} < eta ${eta} — waiting ~${remaining}s`);
    await sleep(Math.min(remaining + 3, 15) * 1000);
  }

  console.log("[4/4] execute(ADD_WRITER, writer) — after the delay …");
  const executeHash = await wallet.writeContract({
    ...call,
    functionName: "execute",
    args: [OP_KIND.ADD_WRITER, writer],
  });
  await pub.waitForTransactionReceipt({ hash: executeHash });

  const isWriterNow = (await pub.readContract({
    ...call,
    functionName: "isWriter",
    args: [writer],
  })) as boolean;
  console.log(`      isWriter(writer) = ${isWriterNow} (raw eth_call readback)`);
  if (!isWriterNow) throw new Error("execute did not authorize the writer — readback is false.");

  const receipt = {
    contract,
    prd: "§7.4 / §10.3",
    network: "X Layer testnet",
    chainId,
    admin,
    writer,
    timelockDelaySeconds: Number(timelockDelay),
    opId,
    eta: Number(eta),
    earlyExecuteReverted: earlyReverted,
    txs: { propose: proposeHash, execute: executeHash },
    isWriterAfter: isWriterNow,
    provisionedThroughTimelock: true,
    note: "Real testnet propose → prove-early-revert (eth_call) → real 60s wait → execute. isWriter read back via raw eth_call, not from stdout.",
  };
  writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");

  console.log("\n=== PROVISIONING RECEIPT ===");
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`\n✓ writer provisioned through the real timelock. Receipt → ${RECEIPT_PATH}`);
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
