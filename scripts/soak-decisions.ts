import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDecisionSoak, type CycleRecord } from "./soak/decisions";

/**
 * Runs the off-chain decision soak (PRD §28) and writes independently-replayable evidence:
 *   internal/day0/soak-evidence/decisions.jsonl   — one line per real cycle
 *   internal/day0/soak-evidence/decisions-summary.json — counts + all-ok flag
 *
 * `pnpm soak:decisions`
 */

const EVIDENCE_DIR = fileURLToPath(new URL("../internal/day0/soak-evidence/", import.meta.url));

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const summary = await runDecisionSoak();

  const jsonl = summary.records.map((r: CycleRecord) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(`${EVIDENCE_DIR}decisions.jsonl`, jsonl);
  writeFileSync(
    `${EVIDENCE_DIR}decisions-summary.json`,
    JSON.stringify({ total: summary.total, byOutcome: summary.byOutcome, allOk: summary.allOk }, null, 2),
  );

  console.log("── Off-chain decision soak (PRD §28) ───────────────────────────────────────");
  console.log(`total cycles     : ${summary.total}`);
  for (const [k, v] of Object.entries(summary.byOutcome)) console.log(`  ${k.padEnd(22)}: ${v}`);
  const failures = summary.records.filter((r) => !r.ok);
  console.log(`failures         : ${failures.length}`);
  for (const f of failures) console.log(`  ✗ #${f.seq} ${f.variant} → ${f.decision} ${f.escalationFinal ?? ""} ${f.verifyFinal ?? ""}`);
  console.log(`evidence         : ${EVIDENCE_DIR}decisions.jsonl (+ summary)`);
  if (!summary.allOk) {
    console.error("\n✗ SOAK FAILED — at least one cycle did not reach its intended outcome.");
    process.exit(1);
  }
  console.log("\n✓ PASS — every cycle reached its intended §28 outcome, intentHash independently re-derived.");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
