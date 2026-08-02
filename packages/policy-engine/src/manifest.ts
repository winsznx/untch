/**
 * Which evaluator produced a decision.
 *
 * WHY A POLICY HASH IS NOT ENOUGH
 *
 * `policyHash` commits to the RULESET — the numbers and lists a user chose, anchored on chain. It says
 * nothing about the code that read them. Today `hardCap` and `duplicates.keys` began being enforced
 * for a policy that was registered before either rule existed: same ruleset, same hash, materially
 * different verdicts. A decision recording only the policy hash cannot tell those two evaluations
 * apart, and a dispute about a past decision would have no way to establish which engine judged it.
 *
 * So a decision now carries the identity of the evaluator as well as the identity of the rules.
 *
 * WHAT THE MANIFEST HASH COVERS, AND WHAT IT DOES NOT
 *
 * The ordered list of implemented rule names. That is deliberately narrow: it changes when a rule is
 * added, removed or reordered, which are exactly the changes that alter which rule decides. It does
 * NOT change when a rule's internals change without changing the list — a wrong comparison inside an
 * existing rule would keep the same manifest hash.
 *
 * `ENGINE_VERSION` is what covers that case, and it is a hand-maintained number precisely because a
 * derived one would give false assurance. Bump it when behaviour changes. The two together answer
 * "which rules ran, in what order, under which implementation".
 */

import { createHash } from "node:crypto";
import { IMPLEMENTED_RULES } from "./rules";

/**
 * Bumped when evaluation behaviour changes, by hand.
 *
 * 2 — `hardCap.absolute` added ahead of `perCall.cap`; `ruleDuplicate` reads `duplicates.keys`
 *     instead of a hardcoded tuple. Both changed verdicts for rulesets already anchored on chain.
 * 1 — the thirteen-rule evaluator.
 */
export const ENGINE_VERSION = "2" as const;

/** `sha256` over the ordered rule names, `0x`-prefixed to read like every other hash here. */
export const RULE_MANIFEST_HASH: string = `0x${createHash("sha256")
  .update(IMPLEMENTED_RULES.join("\n"))
  .digest("hex")}`;

export interface EvaluatorIdentity {
  readonly engineVersion: string;
  readonly ruleManifestHash: string;
  readonly ruleCount: number;
  /** The rule names themselves, so a reader need not have this build to know what ran. */
  readonly rules: readonly string[];
}

export function evaluatorIdentity(): EvaluatorIdentity {
  return {
    engineVersion: ENGINE_VERSION,
    ruleManifestHash: RULE_MANIFEST_HASH,
    ruleCount: IMPLEMENTED_RULES.length,
    rules: [...IMPLEMENTED_RULES],
  };
}
