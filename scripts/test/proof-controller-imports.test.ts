import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Proof by ABSENCE: the controller cannot execute a payment, because the code that could is not in it.
 *
 * WHY THIS IS THE MOST IMPORTANT TEST IN THE CONTROLLER SUITE
 *
 * Every other assertion about the controller checks a behaviour. This one checks a capability, and a
 * capability is what the whole architecture rests on. PASS 1's `--deployed-worker-only` was a
 * conditional inside a module that had already imported `PgConsumerStore`, `X402SolanaExactClient` and
 * the adapter registry. The constructors were resident and reachable; the flag only changed which of
 * them got called. So the boundary lived in the control flow, and a control-flow boundary is one edit
 * away from not being a boundary.
 *
 * A comment saying "this file imports nothing dangerous" is worth nothing for the same reason. So this
 * test WALKS THE REAL GRAPH from the controller entrypoints, resolving relative imports on disk, and
 * asserts that no module in the transitive closure is one that could open a database, construct a
 * signer, build a rail client or execute a provider.
 *
 * WHAT IT DOES AND DOES NOT COVER
 *
 * It follows RELATIVE imports, which is exactly the set that matters: everything in this repository is
 * reached that way from a script. Bare specifiers are checked by NAME against a forbidden list rather
 * than resolved — `@untch/consumer-core`'s barrel pulls in `pg`, so importing it at all is the failure,
 * and resolving it would only confirm what the specifier already says. `node:*` builtins are allowed.
 *
 * It reads source text rather than a bundler's output, so a dynamic `await import()` of a forbidden
 * module WOULD be caught: the specifier is still in the file. That is deliberate — the dispatcher uses
 * dynamic import for the local implementation, and this test is what stops someone from adding a dynamic
 * import of a store to the controller and calling it lazy loading.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** The entrypoints whose closures must stay clean. */
const CONTROLLER_ENTRYPOINTS = [
  "scripts/proof-controller/runner.ts",
  "scripts/proof-controller/contract.ts",
];

/**
 * Repository modules the controller must never reach, and what each one would give it.
 *
 * Matched on a path fragment, so a rename that keeps the meaning still trips. The reason strings are
 * here because a failure of this test needs to tell whoever caused it WHY the module is forbidden, not
 * merely that a list was violated.
 */
const FORBIDDEN_MODULES: readonly (readonly [string, string])[] = [
  ["packages/consumer-core/src/repo-pg", "a Postgres store — this is the production database"],
  ["packages/consumer-core/src/repo-memory", "an in-memory store, which a production proof must never use"],
  ["packages/consumer-core/src/db", "a connection pool"],
  ["packages/consumer-core/src/treasury", "the treasury router, which constructs rail clients"],
  ["packages/consumer-core/src/index", "the barrel, which re-exports the Postgres store and the treasury"],
  ["packages/consumer-providers", "provider adapters and the x402 rail clients that sign payments"],
  ["packages/policy-store/src/repo-pg", "the policy store's Postgres repository"],
  ["packages/policy-store/src/registry", "a chain client that can sign policy mutations"],
  ["packages/receipt-writer", "the receipt writer, which holds a signing key"],
  ["services/asp/src/consumer/orchestrator", "the orchestrator, whose executeIntent spends money"],
  ["services/asp/src/consumer/wiring", "the wiring that builds a store, a treasury and a worker"],
  ["services/asp/src/consumer/dispatcher", "the outbox dispatcher, a worker loop"],
  ["services/asp/src/receipts", "receipt wiring, which needs a database and a key"],
  ["services/asp/src/server", "the whole service"],
  ["scripts/consumer-smoke-live", "the LOCAL implementation, which holds all of the above"],
];

/** Bare specifiers that are forbidden by name. Resolving them would only confirm the specifier. */
const FORBIDDEN_PACKAGES: readonly (readonly [string, string])[] = [
  ["pg", "a Postgres driver"],
  ["@untch/consumer-core", "the barrel that re-exports the Postgres store and the treasury router"],
  ["@untch/consumer-providers", "provider adapters and signing rail clients"],
  ["@untch/receipt-writer", "a signing receipt writer"],
  ["@solana/web3.js", "Solana transaction construction"],
  ["@solana-program/token", "SPL token instruction building"],
  ["@solana/kit", "Solana signing primitives"],
  ["@x402/svm", "x402 Solana payment credential construction"],
  ["@x402/fetch", "an x402 paying fetch client"],
  ["viem", "EVM signing and transaction submission"],
  ["ioredis", "the queue Redis connection"],
  ["bullmq", "the job queue"],
  ["dotenv", "loading the root .env, which is what the allowlisted environment exists to avoid"],
];

/** `import x from "y"`, `export … from "y"`, and `import("y")` — the three ways a specifier appears. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*export\s[^;]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersIn(source: string): readonly string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    // `matchAll` needs a fresh lastIndex per file; the regexes are module-level and global.
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) found.add(spec);
    }
  }
  return [...found];
}

/** Resolve a relative specifier the way tsx does: exact, then `.ts`, then `/index.ts`. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts"), `${base}.js`.replace(/\.js$/, ".ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

interface GraphNode {
  readonly file: string;
  readonly via: readonly string[];
}

/** Walk the transitive closure of relative imports, recording the path that reached each module. */
function importClosure(entry: string): {
  readonly modules: readonly GraphNode[];
  readonly bareSpecifiers: readonly { readonly spec: string; readonly via: readonly string[] }[];
} {
  const abs = resolve(REPO_ROOT, entry);
  assert.ok(existsSync(abs), `entrypoint ${entry} does not exist`);

  const seen = new Set<string>();
  const modules: GraphNode[] = [];
  const bareSpecifiers: { spec: string; via: readonly string[] }[] = [];
  const queue: GraphNode[] = [{ file: abs, via: [entry] }];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    if (seen.has(node.file)) continue;
    seen.add(node.file);
    modules.push(node);

    const source = readFileSync(node.file, "utf8");
    for (const spec of specifiersIn(source)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(node.file, spec);
        assert.ok(
          resolved !== null,
          `${relative(REPO_ROOT, node.file)} imports "${spec}", which does not resolve on disk. This test ` +
            "must be able to follow every relative import, or its guarantee is partial.",
        );
        queue.push({ file: resolved, via: [...node.via, relative(REPO_ROOT, resolved)] });
      } else {
        bareSpecifiers.push({ spec, via: node.via });
      }
    }
  }

  return { modules, bareSpecifiers };
}

describe("the controller's import graph cannot reach anything that spends", () => {
  for (const entry of CONTROLLER_ENTRYPOINTS) {
    test(`${entry} reaches no store, signer, adapter or worker module`, () => {
      const { modules } = importClosure(entry);
      const paths = modules.map((m) => relative(REPO_ROOT, m.file));

      for (const [fragment, why] of FORBIDDEN_MODULES) {
        const hit = modules.find((m) => relative(REPO_ROOT, m.file).includes(fragment));
        assert.equal(
          hit,
          undefined,
          `${entry} transitively imports ${fragment} (${why}).\n` +
            `  reached via: ${hit?.via.join(" -> ")}\n` +
            "  The controller's evidence is only worth something if it COULD NOT have done the work itself.",
        );
      }

      // A sanity floor. If resolution silently found nothing, every assertion above would pass vacuously,
      // which is the one failure mode a test like this must not have.
      assert.ok(paths.length >= 2, `expected a real closure, walked only ${paths.join(", ")}`);
    });

    test(`${entry} imports no package that could sign, connect or pay`, () => {
      const { bareSpecifiers } = importClosure(entry);
      for (const [pkg, why] of FORBIDDEN_PACKAGES) {
        const hit = bareSpecifiers.find((b) => b.spec === pkg || b.spec.startsWith(`${pkg}/`));
        assert.equal(
          hit,
          undefined,
          `${entry} transitively imports "${pkg}" (${why}).\n  reached via: ${hit?.via.join(" -> ")}`,
        );
      }
    });
  }

  /**
   * The closure is small, and that is the property rather than a coincidence.
   *
   * A controller whose graph grew to dozens of modules would be one nobody could reason about, and the
   * forbidden list only covers what someone thought to forbid. A tight bound catches the import nobody
   * predicted — including a new one added years from now — by failing on size before anyone has to
   * classify it.
   */
  test("the closure stays small enough to read in one sitting", () => {
    const { modules } = importClosure("scripts/proof-controller/runner.ts");
    const paths = modules.map((m) => relative(REPO_ROOT, m.file)).sort();
    assert.ok(
      paths.length <= 6,
      `the controller now reaches ${paths.length} modules:\n  ${paths.join("\n  ")}\n` +
        "If this is a deliberate addition, confirm the new module cannot open a database, hold a key or " +
        "call a provider, then raise this bound with a note saying why.",
    );
  });

  /**
   * The dispatcher must import NOTHING heavy at the top level.
   *
   * It is the file both modes pass through. A static import of either implementation there would load
   * that implementation for both, which would undo the split entirely — the controller would be running
   * in a process that had already constructed a store.
   */
  test("the dispatcher statically imports nothing at all", () => {
    const source = readFileSync(resolve(REPO_ROOT, "scripts/consumer-smoke-live-entry.ts"), "utf8");
    const staticImports = [...source.matchAll(/(?:^|\n)\s*import\s[^(]/g)];
    assert.equal(
      staticImports.length,
      0,
      "the dispatcher has a static import. Both modes pass through this file, so a static import loads " +
        "that module for the controller too, and the import boundary stops existing.",
    );
    assert.ok(source.includes('await import("./proof-controller/runner")'));
    assert.ok(source.includes('await import("./consumer-smoke-live")'));
  });

  /**
   * The local implementation must REFUSE the flag rather than ignore it.
   *
   * If the dispatcher is ever bypassed — a direct `tsx scripts/consumer-smoke-live.ts
   * --deployed-worker-only`, a stale runbook line, a shell alias — the operator must be told, not handed
   * a local run they will report as remote evidence.
   */
  test("the local implementation refuses the deployed flag", () => {
    const source = readFileSync(resolve(REPO_ROOT, "scripts/consumer-smoke-live.ts"), "utf8");
    assert.ok(
      /if \(has\("deployed-worker-only"\)\) \{\s*\n\s*stop\(/.test(source),
      "consumer-smoke-live.ts must stop() on --deployed-worker-only rather than branch on it",
    );
    assert.ok(
      !/const deployedWorkerOnly/.test(source),
      "consumer-smoke-live.ts still binds the flag to a variable, which means it still branches on it",
    );
  });
});
