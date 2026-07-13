import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Renders internal/day0/soak-public-runbook.md from public-bundle.json — so the copy-paste `cast`
 * commands the human runs can never drift from the prepared calldata. Run after prepare-public-bundle.ts.
 */

interface Tx {
  id: string;
  purpose: string;
  signer: "OWNER" | "WRITER" | "ANY_FUNDED";
  kind: "send" | "eth_call-expect-revert";
  to: string;
  value: string;
  data: string;
  expect: string;
  verify: string;
}
interface KeyInfo {
  address: string;
  note: string;
}
interface Bundle {
  network: { chainId: number; rpc: string; explorer: string };
  contracts: { vault: string; token: string; receipts: string };
  keys: { OWNER: KeyInfo; WRITER: KeyInfo; oracleOld: KeyInfo; oracleNew: KeyInfo };
  constants: Record<string, string>;
  representativeSample: { index: Array<Record<string, unknown>>; txs: Tx[] };
  drills: { pause: Tx[]; oracleRotation: Tx[] };
}

const EVID = fileURLToPath(new URL("../../internal/day0/soak-evidence/", import.meta.url));
const OUT = fileURLToPath(new URL("../../internal/day0/soak-public-runbook.md", import.meta.url));
const b = JSON.parse(readFileSync(`${EVID}public-bundle.json`, "utf8")) as Bundle;

const walletFor: Record<Tx["signer"], string> = {
  OWNER: "$OWNER_PK   # your vault-owner key (0x98F4…3c0b)",
  WRITER: "$WRITER_PK  # your authorized receipt-writer key (0x03e5…1ab5)",
  ANY_FUNDED: "$ANY_PK    # any funded wallet — spend() is oracle-authorized, not owner-gated",
};

function renderTx(n: number, t: Tx): string {
  if (t.kind === "eth_call-expect-revert") {
    return [
      `### ${n}. ${t.id} — **assertion (no tx, gas-free)**`,
      `${t.purpose}. Expected: **${t.expect}**.`,
      "",
      "```bash",
      t.verify,
      "```",
      "",
    ].join("\n");
  }
  return [
    `### ${n}. ${t.id}`,
    `${t.purpose}`,
    `- **signer:** \`${t.signer}\` → ${walletFor[t.signer]}`,
    `- **expect:** ${t.expect}`,
    "",
    "```bash",
    `cast send ${t.to} \\`,
    `  ${t.data} \\`,
    `  --private-key ${(walletFor[t.signer].split("#")[0] ?? "").trim()} --rpc-url $RPC`,
    "# record the printed transactionHash, then verify:",
    t.verify,
    "```",
    "",
  ].join("\n");
}

const lines: string[] = [];
lines.push("# §28 soak — public testnet execution runbook");
lines.push("");
lines.push(
  "Generated from [soak-evidence/public-bundle.json](soak-evidence/public-bundle.json) by " +
    "`scripts/soak/render-runbook.ts` — the calldata below is byte-for-byte what the preparer produced " +
    "and was **preflighted via `eth_call` against live public state** (both a sample spend and a receipt " +
    "returned success with no key). Run the steps IN ORDER within each section.",
);
lines.push("");
lines.push("## What you sign vs what is pre-baked");
lines.push("");
lines.push(
  "- **You** sign every tx with your own wallet — this runbook never asks for, and the preparer never " +
    "handled, any key. Owner-only txs need your **owner** key; receipts need your **writer** key; spends " +
    "accept **any funded** wallet.",
);
lines.push(
  "- **Oracle signatures are pre-baked** inside each spend's calldata, signed by the vault's *public demo " +
    "oracle* (anvil #1 — the deployed vault's own oracle, a documented throwaway), NOT any owner key. You " +
    "only broadcast the tx.",
);
lines.push("");
lines.push("## Setup");
lines.push("");
lines.push("```bash");
lines.push(`export RPC=${b.network.rpc}   # X Layer testnet ${b.network.chainId}`);
lines.push("export OWNER_PK=0x…   # your vault-owner key (address " + b.keys.OWNER.address + ")");
lines.push("export WRITER_PK=0x…  # your receipt-writer key (address " + b.keys.WRITER.address + ")");
lines.push("export ANY_PK=$OWNER_PK   # or any other funded wallet");
lines.push("```");
lines.push("");
lines.push("**Contracts:** vault `" + b.contracts.vault + "` · receipts `" + b.contracts.receipts + "` · token `" + b.contracts.token + "`.");
lines.push("**Explorer:** " + b.network.explorer + "  (append `/tx/<hash>` or `/address/<addr>`)");
lines.push("");
lines.push("Before you start, confirm the vault is in its documented pre-drill state:");
lines.push("");
lines.push("```bash");
lines.push(`cast call ${b.contracts.vault} 'oracle()(address)' --rpc-url $RPC   # ${b.keys.oracleOld.address}`);
lines.push(`cast call ${b.contracts.vault} 'paused()(bool)' --rpc-url $RPC      # false`);
lines.push("```");
lines.push("");

lines.push("---");
lines.push("");
lines.push("## Part A — Representative sample (2× each outcome = 10 cycles)");
lines.push("");
lines.push(
  "Each cycle is a REAL decision from the engine, anchored on-chain as a receipt (`logReceipts`). The two " +
    "**settling** outcomes (approve, escalate-approve) additionally move money via a real Mode-C vault " +
    "`spend()`; the three **withholding** outcomes (block, escalate-timeout, verify-fail-withhold) anchor a " +
    "receipt and deliberately do NOT spend — the settle/withhold split is visible on-chain as the presence " +
    "or absence of a `VaultSpend`.",
);
lines.push("");
lines.push("| # | outcome | decision recorded | receipt | vault spend |");
lines.push("|---|---|---|---|---|");
b.representativeSample.index.forEach((x, i) => {
  lines.push(`| ${i + 1} | ${x.outcome} | ${x.decision} | yes | ${x.spend ? "yes" : "— (withheld)"} |`);
});
lines.push("");
b.representativeSample.txs.forEach((t, i) => lines.push(renderTx(i + 1, t)));

lines.push("---");
lines.push("");
lines.push("## Part B — Pause drill (run in order)");
lines.push("");
lines.push(
  "Proves: a paused vault blocks oracle-signed spends, but `ownerWithdraw` still works while paused " +
    "(§16 I4 invariant), and normal operation resumes after unpause. Ends unpaused — the vault is left as found.",
);
lines.push("");
b.drills.pause.forEach((t, i) => lines.push(renderTx(i + 1, t)));

lines.push("---");
lines.push("");
lines.push("## Part C — Oracle-rotation drill (run in order)");
lines.push("");
lines.push(
  "Proves: after `setOracle`, the OLD oracle's signature is rejected and the NEW oracle's is accepted, " +
    "with owner/caps/token-allowlist untouched. The final step RESTORES the original oracle — the vault is " +
    "left exactly as found.",
);
lines.push("");
b.drills.oracleRotation.forEach((t, i) => lines.push(renderTx(i + 1, t)));

lines.push("---");
lines.push("");
lines.push("## After you run everything");
lines.push("");
lines.push(
  "Paste back the printed `transactionHash` for each **send** step (21 total), keyed by step id. " +
    "I will independently verify every one via raw RPC / explorer — decode the `VaultSpend` / `ReceiptLogged` " +
    "/ `OracleChanged` / `Paused` events, confirm balances and `nonceUsed`, and fold the real hashes into the " +
    "final soak-test-results.md alongside the fork-based volume proof.",
);
lines.push("");

writeFileSync(OUT, lines.join("\n"));
console.log(`runbook written: ${OUT} (${lines.length} lines)`);
