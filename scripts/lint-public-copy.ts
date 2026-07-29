/**
 * `pnpm lint:public-copy` — the CLI over scripts/lint/public-copy.ts.
 *
 * Kept separate from the rules module so the rules can be imported by tests without a process exit
 * happening as a side effect of the import.
 */

import { readFileSync } from "node:fs";
import { relative, extname } from "node:path";
import { collectFiles, lintText, SCOPE, type Violation } from "./lint/public-copy";

const ROOT = process.cwd();

function main(): void {
  const files = collectFiles();

  if (process.argv.includes("--list")) {
    console.log(`public-copy scope: ${files.length} file(s)\n`);
    for (const s of SCOPE) {
      const n = files.filter((f) => f.label === s.label).length;
      console.log(`  ${s.path.padEnd(38)} ${s.exts.join(",").padEnd(12)} ${String(n).padStart(3)} file(s)  ${s.label}`);
    }
    return;
  }

  const violations: Violation[] = [];
  for (const { file } of files) {
    violations.push(...lintText(readFileSync(file, "utf8"), relative(ROOT, file), extname(file)));
  }

  if (violations.length === 0) {
    console.log(`\x1b[32m✓\x1b[0m public copy: ${files.length} file(s) clean`);
    return;
  }

  const byRule = new Map<string, number>();
  for (const v of violations) byRule.set(v.ruleId, (byRule.get(v.ruleId) ?? 0) + 1);

  console.error(`\n\x1b[31m${violations.length} public-copy violation(s)\x1b[0m\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    \x1b[33m${v.ruleId}\x1b[0m  ${v.message}`);
    console.error(`    ${v.text}`);
  }
  console.error("\n  by rule:");
  for (const [id, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.error(`    ${String(n).padStart(4)}  ${id}`);
  }
  console.error("\n  See internal/public-copy-standard.md. To allow one specific line, put");
  console.error("  `copy-lint-disable-next-line <reason>` in a comment on the line before it.\n");
  process.exit(1);
}

main();
