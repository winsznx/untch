/**
 * The `@untch/shared` entry point.
 *
 * `chains.ts` was the package main for the whole build, so every existing `from "@untch/shared"`
 * import resolved to it directly. That still works: everything it exported is re-exported here
 * unchanged. The barrel exists so the DERIVED chain registry can live in its own module without
 * importing the package into itself.
 */
export * from "./chains";
export * from "./chain-registry";
