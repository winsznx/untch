/**
 * Which code is actually serving, on a runtime that has no filesystem to ask.
 *
 * THE INCIDENT THIS INHERITS FROM
 *
 * On 2026-07-29 two deployments carrying a new spending gate failed at the build step. No container
 * was created, so an older container that predated the gate kept serving, and spending authority was
 * granted in the belief that the new code was live. Nothing the service emitted made that
 * distinguishable. The lesson was narrow: anything granting authority on the assumption that new code
 * is live must ask the RUNNING PROCESS what it is, and get an answer that cannot be faked by a stale
 * configuration value.
 *
 * WHY THE ANSWER IS COMPILED IN RATHER THAN CONFIGURED
 *
 * The Node deployment writes `.untch-build-attestation.json` INTO the uploaded tree and reads it off
 * disk. Workers has no disk, and the obvious substitute — a Wrangler `[vars]` entry set by the deploy
 * script — is the exact failure mode the original comment warns about. A variable outlives the
 * deployment that set it, so a var saying "commit X" after the build for X failed reproduces the
 * incident with extra steps.
 *
 * So the attestation is GENERATED INTO THE SOURCE TREE by `pnpm gen:attestation` and bundled by
 * esbuild along with everything else. It cannot drift from the code beside it, because it is compiled
 * from the same tree in the same step. If the build fails, no bundle ships and no claim ships either.
 *
 * WHEN IT IS ABSENT
 *
 * Reported as unattested rather than guessed at. An unattested deployment is one that must not be
 * armed, and saying so is more useful than inventing a commit.
 */

import type { BuildAttestation } from "../deployment-info";
import { GENERATED_ATTESTATION } from "./build-attestation.generated";

/**
 * The attestation this bundle carries, or null when it carries none.
 *
 * The generated module is checked in as `null` so this import always resolves — a missing generated
 * file would be a build error on every machine that had not just deployed, which would push people
 * toward committing a real attestation to make the build work. That is the outcome to avoid: an
 * attestation committed to a branch describes a deployment that no longer exists.
 */
export const BUNDLED_ATTESTATION: BuildAttestation | null = GENERATED_ATTESTATION;

/** The reader handed to `DeploymentLifecycle` by the Worker entry. No filesystem, no configuration. */
export function bundledAttestation(): BuildAttestation | null {
  return BUNDLED_ATTESTATION;
}

/**
 * Whether this bundle may be granted spending authority.
 *
 * Deliberately a separate question from "is it healthy". A Worker with no attestation serves fine and
 * must still be refused an arming decision, because nothing about it proves which commit is running —
 * which is the precise condition that turned a failed build into granted authority in July.
 */
export function isAttestedForArming(): boolean {
  return BUNDLED_ATTESTATION !== null;
}
