/**
 * `pnpm consumer:smoke:live` — two commands behind one name, chosen before either is loaded.
 *
 * WHY A DISPATCHER AND NOT A FLAG
 *
 * The two modes are not variations on a run. They are opposites:
 *
 *   LOCAL DEVELOPMENT MODE   holds the production database URL, seeds the registry, constructs a rail
 *                            client from a treasury key, and executes the provider itself.
 *   DEPLOYED CONTROLLER MODE holds none of those, and its entire claim rests on not holding them.
 *
 * A flag cannot express that. `import` statements are hoisted and evaluated before any argument parsing
 * runs, so a single file containing both modes has already loaded `PgConsumerStore`,
 * `X402SolanaExactClient` and the adapter registry by the time it discovers which mode it is in. The
 * modules would be resident, the constructors reachable, and the boundary would exist only in the
 * control flow — which is precisely the shape of the defect this replaces: the old
 * `--deployed-worker-only` skipped one call and kept every capability.
 *
 * `await import()` is the fix, and it is the whole reason this file exists. Nothing heavy is imported at
 * the top. Exactly one of the two implementations is loaded, after the decision, and the other is never
 * evaluated in this process. `scripts/test/proof-controller-imports.test.ts` walks the controller's real
 * import graph and asserts that no store, signer, adapter or rail-client module appears in it.
 */

/**
 * Marks this file a module so the top-level `await import()` below is legal.
 *
 * Deliberately empty. Exporting anything real would give another file a reason to import the dispatcher,
 * and a dispatcher that is imported rather than executed would run its side effects inside someone
 * else's process.
 */
export {};

const deployedWorkerOnly = process.argv.includes("--deployed-worker-only");

if (deployedWorkerOnly) {
  /**
   * The controller path. Loads `scripts/proof-controller/runner.ts` and nothing else.
   *
   * The runner self-executes and owns its own exit codes, because its refusals carry remediation text
   * that a generic wrapper would flatten into a stack trace.
   */
  await import("./proof-controller/runner");
} else {
  await import("./consumer-smoke-live");
}
