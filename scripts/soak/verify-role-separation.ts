import { pairwiseDistinct, readRoleAddresses, ROLE_ENV, ROLES } from "./role-lib";

/**
 * §28 pre-deploy gate — role-separation distinctness. Given the FIVE public role addresses
 * (deployer/owner/admin/writer/oracle) via env vars, asserts all TEN pairwise inequalities and fails
 * loudly if any two match. This is the mechanical enforcement of the least-privilege lesson from the
 * owner-key-loss incident: one key must never hold two roles (there, deployer == owner == admin).
 *
 * PUBLIC ADDRESSES ONLY. This tool does not generate, request, or need any private key. Run it once the
 * human has provisioned the five addresses:
 *
 *   DEPLOYER_ADDRESS=0x… OWNER_ADDRESS=0x… ADMIN_ADDRESS=0x… WRITER_ADDRESS=0x… ORACLE_ADDRESS=0x… \
 *     pnpm verify:role-separation
 *
 * Exit 0 iff all five are present, well-formed, and pairwise distinct; exit 1 (loud) otherwise.
 */

function main(): void {
  const { addresses, missing, malformed } = readRoleAddresses(process.env);

  console.log("── §28 role-separation gate (public addresses only) ────────────────────────");
  for (const role of ROLES) {
    const a = addresses[role];
    console.log(`  ${role.padEnd(9)} ${ROLE_ENV[role].padEnd(17)} ${a ?? "(missing/invalid)"}`);
  }

  const problems: string[] = [];
  if (missing.length) problems.push(`missing: ${missing.map((r) => ROLE_ENV[r]).join(", ")}`);
  for (const m of malformed) problems.push(`malformed ${ROLE_ENV[m.role]}: "${m.value}" is not a valid EVM address`);
  if (problems.length) {
    console.error("\n✗ FAIL — supply all five valid addresses:");
    for (const p of problems) console.error(`   • ${p}`);
    process.exit(1);
  }

  const checks = pairwiseDistinct(addresses);
  const collisions = checks.filter((c) => !c.distinct);
  console.log(`\n  pairwise checks (${checks.length}):`);
  for (const c of checks) {
    console.log(`    ${c.distinct ? "✓" : "✗"} ${c.a} ≠ ${c.b}` + (c.distinct ? "" : `   BOTH = ${c.addrA}`));
  }

  if (collisions.length) {
    console.error(`\n✗ FAIL — ${collisions.length} role collision(s); one key would hold multiple roles:`);
    for (const c of collisions) console.error(`   • ${c.a} and ${c.b} are the SAME address (${c.addrA})`);
    console.error("   Fix: assign a distinct, separately-custodied key to each role (see key-custody-and-rotation-runbook.md §5,§7).");
    process.exit(1);
  }

  console.log(`\n✓ PASS — all 5 roles present, valid, and pairwise distinct (${checks.length}/10 inequalities hold).`);
}

main();
