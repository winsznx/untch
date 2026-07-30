import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No runtime package may be resolved DURING a Solana payment.
 *
 * This encodes an invariant rather than an example, because the failure it guards against is invisible
 * in ordinary testing. Every package involved is a declared production dependency and every one of them
 * resolves, so a dynamic import here passes all tests, passes a production-only install, and still
 * changes what happens on the day resolution fails.
 *
 * WHY THE TIMING IS THE WHOLE POINT
 *
 * `buildV2SvmCredential` constructs the signer and produces the PAYMENT-SIGNATURE. It is reached only
 * after the durable proof gate has moved to CLAIMED, which is the record saying the treasury's authority
 * MIGHT already have been used. A module resolution failure inside that window cannot be reported as a
 * clean refusal: the gate cannot be released without proving no credential was ever created, and "the
 * import failed" is not that proof from the gate's point of view. The result is a MANUAL_REVIEW on a
 * payment that never happened.
 *
 * Resolved at module load instead, the same failure stops the process from starting. The readiness gate
 * then fails the health check and the deployment never serves, which is a deployment problem rather than
 * an on-chain investigation.
 *
 * The scan is deliberately narrow. It covers the x402 payment directory only, and it permits relative
 * imports, because the hazard is resolving an EXTERNAL package late, not code organisation.
 */

const X402_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "x402");

/** `import(` occurrences that are real dynamic imports of a bare package specifier. */
function dynamicPackageImports(source: string): string[] {
  const found: string[] = [];
  // Strip block and line comments so prose describing an import is not mistaken for one.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1] ?? "";
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    found.push(spec);
  }
  return found;
}

describe("the Solana payment path resolves nothing at payment time", () => {
  test("no file under src/x402 dynamically imports an external package", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(X402_DIR)) {
      if (!file.endsWith(".ts")) continue;
      const specs = dynamicPackageImports(readFileSync(join(X402_DIR, file), "utf8"));
      for (const spec of specs) offenders.push(`${file} -> ${spec}`);
    }

    assert.deepEqual(
      offenders,
      [],
      "these must be static imports. A package resolved after the proof gate is CLAIMED turns a " +
        "resolution failure into an unresolvable settlement ambiguity:\n  " + offenders.join("\n  "),
    );
  });

  test("the guard actually detects a dynamic import", () => {
    // A guard that cannot fail is not a guard. If the matcher silently stopped working, the test above
    // would pass forever while the invariant rotted.
    assert.deepEqual(dynamicPackageImports(`const kit = await import("@solana/kit");`), ["@solana/kit"]);
    assert.deepEqual(dynamicPackageImports(`await import('@x402/svm')`), ["@x402/svm"]);
    // Relative imports are allowed, and prose is not code.
    assert.deepEqual(dynamicPackageImports(`await import("./local")`), []);
    assert.deepEqual(dynamicPackageImports(`/* we used to await import("@solana/kit") here */`), []);
    assert.deepEqual(dynamicPackageImports(`// await import("@x402/fetch")`), []);
  });
});

/**
 * The four packages the payment path needs, asserted to be PRODUCTION dependencies.
 *
 * A devDependency resolves in a workspace install and disappears under `pnpm install --prod`. Since the
 * payment path now imports these at module load, a misplaced one would stop the service from starting in
 * exactly the environment where that is hardest to debug. CI additionally performs a real production-only
 * install and imports the package from it, which is the empirical half of this check.
 */
describe("the payment path's packages are production dependencies", () => {
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  for (const pkg of ["@solana/kit", "@x402/svm", "@x402/fetch", "@solana-program/token"]) {
    test(`${pkg} is a runtime dependency, not a dev one`, () => {
      assert.ok(manifest.dependencies?.[pkg], `${pkg} must be in dependencies`);
      assert.ok(!manifest.devDependencies?.[pkg], `${pkg} must not be in devDependencies`);
    });
  }
});
