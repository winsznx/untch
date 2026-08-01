import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WELL_KNOWN_DEV_KEYS } from "../packages/consumer-core/src/config";

/**
 * Refuse to ship a production surface that names something only a test environment has.
 *
 * WHY THIS EXISTS
 *
 * Four separate testnet references reached production-visible code and none of them was caught by a
 * type, a test, or a review: sign-in accepted a retired chain, the consumer flag layer mapped a
 * documented variable onto it, the policy store defaulted its registry to testnet, and the helper a
 * caller uses to create the policy the marketplace demands defaulted to a testnet RPC. Individually
 * each was a plausible line of code. What they had in common is that nothing in the build asked the
 * question "may a production surface say this?"
 *
 * This asks it. It is a scanner, not a type system, so it is deliberately narrow: it looks for the
 * specific literals that mean "not production" and it fails on them, in the specific directories that
 * serve or describe production.
 *
 * WHY A DENYLIST AND NOT AN ALLOWLIST
 *
 * An allowlist of permitted strings over source code is a spellchecker, and it would be turned off
 * within a week. The values here are the ones whose presence in a served response is a factual error
 * about which network the product runs on. That is a short, stable list.
 *
 * WHY SCOPES RATHER THAN A GLOBAL BAN
 *
 * Testnet values are not forbidden; the repository legitimately deploys to testnet, proves things on
 * testnet, and records testnet receipts. They are forbidden in code whose output a stranger can read.
 * So the scan covers PRODUCTION SCOPES and skips TEST SCOPES, and both lists are explicit — a file
 * that is neither is scanned, because the safe default for an unclassified file is to check it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Directories whose source can end up in a response, a manifest, or a public page. */
const PRODUCTION_SCOPES: readonly string[] = [
  "services/asp/src",
  "packages/consumer-core/src",
  "packages/consumer-providers/src",
  "packages/policy-store/src",
  "packages/receipt-writer/src",
  "packages/shared/src",
  "packages/trust-bureau/src",
  "packages/reports/src",
  "packages/proof-engine/src",
  "packages/policy-engine/src",
  "packages/x402-guard/src",
  "packages/canon/src",
];

/**
 * Files inside a production scope that are explicitly test-scoped.
 *
 * The `run-*-proof.ts` drivers are the interesting case: they live in `services/asp/src` because they
 * import the service's own modules, but they are operator-run proof scripts that deliberately target
 * testnet. They are named, not pattern-guessed, so adding one is a decision someone makes on purpose.
 */
const TEST_SCOPED = [
  /(^|\/)test(s)?\//,
  /\.test\.ts$/,
  /(^|\/)run-[a-z0-9-]+-proof\.ts$/,
  /(^|\/)prove-[a-z0-9-]+\.ts$/,
  /(^|\/)fixtures?\//,
  /(^|\/)gen-buyer-wallet\.ts$/,
];

/**
 * The chain registry itself, where test-network facts are SUPPOSED to live.
 *
 * Exempting it is the point of having it. A registry that may not name the testnet cannot describe
 * the testnet, and the alternative — spreading those constants back across call sites so no single
 * file trips the scanner — is precisely the shape this whole change removes. Two files, named
 * individually, not a directory that would silently absorb a third.
 */
const REGISTRY_FILES: readonly string[] = [
  "packages/shared/src/chains.ts",
  "packages/shared/src/chain-registry.ts",
  // The dev-key denylist. It must spell out the keys in order to refuse them, and it is the list
  // this scanner's own rule is built from — flagging it would be the scanner flagging itself.
  "packages/consumer-core/src/config.ts",
];

export interface SurfaceRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
}

/**
 * The literals that make a production surface untrue.
 *
 * `chain 195` is matched as a CAIP-2 id or an explicit chainId assignment rather than as the bare
 * number, because "195" appears inside addresses, hashes and unrelated integers, and a rule that
 * cries wolf is a rule that gets deleted.
 */
export const SURFACE_RULES: readonly SurfaceRule[] = [
  {
    id: "localhost",
    pattern: /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?/i,
    why: "a served URL that resolves to the reader's own machine",
  },
  {
    id: "deprecated-xlayer-195",
    pattern: /eip155:195\b|chainId["'\s:=]+195\b|X_LAYER_TESTNET_DEPRECATED_ID/,
    why: "the retired X Layer testnet — no live RPC; the active testnet is 1952",
  },
  {
    id: "testnet-rpc",
    pattern: /testrpc\.xlayer\.tech|xlayertestrpc\.okx\.com/i,
    why: "a testnet RPC endpoint",
  },
  {
    id: "testnet-explorer",
    pattern: /oklink\.com\/x-layer-testnet|sepolia\.[a-z]+scan\.[a-z]+|goerli\.[a-z]+scan\.[a-z]+/i,
    why: "a testnet block explorer link",
  },
  {
    id: "faucet",
    pattern: /faucet/i,
    why: "a faucet URL or reference — faucets exist only on test networks",
  },
  {
    id: "devnet-testnet-hosts",
    pattern: /\b(?:api\.)?devnet\b|\bsepolia\b|\bgoerli\b|\bmumbai\b|solana-devnet|api\.testnet\.solana\.com/i,
    why: "a devnet/testnet network name in a production surface",
  },
  {
    id: "sandbox-provider",
    pattern: /\bsandbox\.[a-z0-9-]+\.[a-z]{2,}|\bapi-sandbox\b|\bsandbox-api\b/i,
    why: "a sandbox provider host",
  },
  {
    id: "test-signing-key",
    // The same set `assertUsableEvmKey` refuses at boot, so the scanner cannot fall behind it.
    pattern: new RegExp(
      [...WELL_KNOWN_DEV_KEYS].map((k) => k.replace(/^0x/, "0x")).join("|"),
      "i",
    ),
    why: "a well-known anvil/hardhat test private key",
  },
];

export interface SurfaceFinding {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly why: string;
  readonly text: string;
}

function isTestScoped(rel: string): boolean {
  const normalised = rel.split(sep).join("/");
  return TEST_SCOPED.some((r) => r.test(normalised));
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|json|mdx?)$/.test(name)) {
      out.push(full);
    }
  }
}

/**
 * The escape hatch: `production-surface-allow: <ruleId> — <reason>`, on the offending line or the line
 * directly above it. Naming the rule and giving a reason is the whole safeguard — it cannot be applied
 * by reflex, and it cannot be copied to a different rule without becoming visibly wrong.
 */
const ALLOW = /production-surface-allow:\s*([a-z0-9-]+)/i;

function allowedRuleAt(rawLines: readonly string[], index: number): string | null {
  const here = ALLOW.exec(rawLines[index] ?? "")?.[1];
  if (here) return here.toLowerCase();
  const above = ALLOW.exec(rawLines[index - 1] ?? "")?.[1];
  return above ? above.toLowerCase() : null;
}

/**
 * Comments are stripped before scanning, and the reason is worth being explicit about.
 *
 * A comment never reaches a response. Every defect this scanner exists for was a VALUE — a constant,
 * an array literal, a default argument. Scanning prose instead flags the code that documents why a
 * testnet reference is refused, which trains reviewers to ignore the output. A scanner nobody reads
 * catches nothing.
 *
 * Stripping is textual and conservative: it does not attempt to understand strings that contain
 * comment markers, and a false NEGATIVE from an oddly-quoted line is preferable to the false-positive
 * flood that made the unstripped version useless.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (ALLOW.test(line) ? line : line.replace(/(^|[^:])\/\/.*$/, "$1")))
    .join("\n");
}

export function scanText(rel: string, text: string): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const scannable = /\.(ts|tsx)$/.test(rel) ? stripComments(text) : text;
  const lines = scannable.split("\n");
  const rawLines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const allowed = allowedRuleAt(rawLines, i);
    for (const rule of SURFACE_RULES) {
      if (allowed === rule.id) continue;
      const m = rule.pattern.exec(line);
      if (m) {
        findings.push({
          file: rel,
          line: i + 1,
          ruleId: rule.id,
          why: rule.why,
          text: (rawLines[i] ?? line).trim().slice(0, 160),
        });
      }
    }
  }
  return findings;
}

export function scanRepository(root: string = ROOT): SurfaceFinding[] {
  const files: string[] = [];
  for (const scope of PRODUCTION_SCOPES) walk(join(root, scope), files);

  const findings: SurfaceFinding[] = [];
  for (const full of files) {
    const rel = relative(root, full).split(sep).join("/");
    if (isTestScoped(rel) || REGISTRY_FILES.includes(rel)) continue;
    findings.push(...scanText(rel, readFileSync(full, "utf8")));
  }
  return findings;
}

/**
 * The deployment half: the same rules, applied to what production actually serves.
 *
 * The repository scan proves the source does not say these things. It cannot prove the SERVING build
 * does not, because the serving build is a tarball that may predate the source. Fetching the public
 * surfaces closes that gap for the routes anyone can read without paying.
 */
export const DEPLOYMENT_SURFACES: readonly string[] = [
  "/catalog",
  "/agent-registration.json",
  "/.well-known/agent-registration.json",
  "/consumer/catalog",
  "/cafe/menu",
];

export async function scanDeployment(baseUrl: string): Promise<SurfaceFinding[]> {
  const findings: SurfaceFinding[] = [];
  for (const path of DEPLOYMENT_SURFACES) {
    let body: string;
    try {
      const res = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
      body = await res.text();
      if (!res.ok) {
        // A 503 from an unwired surface is not a truth defect; it is a configuration state, and this
        // scanner has no opinion about it.
        if (res.status >= 500) continue;
      }
    } catch (err) {
      findings.push({
        file: `${baseUrl}${path}`,
        line: 0,
        ruleId: "unreachable",
        why: `could not be fetched: ${(err as Error).message}`,
        text: "",
      });
      continue;
    }
    findings.push(...scanText(`${baseUrl}${path}`, body));
  }
  return findings;
}

function report(findings: readonly SurfaceFinding[], what: string): boolean {
  if (findings.length === 0) {
    console.log(`[surface] ok — ${what} names nothing test-only`);
    return true;
  }
  console.error(`[surface] ${findings.length} production-visible test reference(s) in ${what}:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.ruleId}] ${f.why}`);
    if (f.text) console.error(`      ${f.text}`);
  }
  console.error(
    "\n  Move the value into a test-scoped file, or annotate the line with " +
      "`production-surface-allow: <ruleId> — <reason>` if it is genuinely not production-visible.",
  );
  return false;
}

async function main(): Promise<void> {
  const deployArg = process.argv.find((a) => a.startsWith("--deployment="));
  let ok = report(scanRepository(), "the repository's production scopes");

  if (deployArg) {
    const base = deployArg.slice("--deployment=".length).replace(/\/$/, "");
    ok = report(await scanDeployment(base), `the deployment at ${base}`) && ok;
  }

  if (!ok) process.exit(1);
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(`[surface] scanner failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
