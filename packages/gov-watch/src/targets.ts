import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Abi, type Address } from "viem";
import type { WatchTarget } from "./watcher";

/**
 * Building the watch list from what was actually deployed, rather than from a hand-maintained address
 * constant that silently rots.
 */

/** The subset of `deployments/mainnet-suite.json` (written by scripts/deploy-mainnet-suite.ts) we need. */
export interface DeploymentArtifact {
  readonly chainId: number;
  readonly spendIntentRegistry: Address;
  readonly receipts: Address;
  readonly policyRegistry?: Address;
  readonly vaultFactory?: Address;
}

const artifactAbi = (contract: string, file: string): Abi => {
  const path = fileURLToPath(new URL(`../../../contracts/out/${contract}.sol/${file}.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { abi: Abi }).abi;
};

/**
 * The two contracts that have governance events on day one.
 *
 * PolicyRegistry and UntchVaultFactory are intentionally NOT watched — they have no admin, no writer,
 * and no owner, so there is no governance event for them to fire (see WATCHED_EVENTS). Watching them
 * would be theatre: a subscription that can never produce an alert reads as coverage while providing
 * none. UntchVault instances become watchable as they are deployed; none exist yet.
 */
export function loadTargets(input: { receipts: Address; spendIntentRegistry: Address }): WatchTarget[] {
  return [
    {
      name: "UntchReceipts",
      address: getAddress(input.receipts),
      abi: artifactAbi("UntchReceipts", "UntchReceipts"),
    },
    {
      name: "SpendIntentRegistry",
      address: getAddress(input.spendIntentRegistry),
      abi: artifactAbi("SpendIntentRegistry", "SpendIntentRegistry"),
    },
  ];
}

/** Read the phase-1 deployment artifact and build the watch list from the real deployed addresses. */
export function loadArtifactTargets(path: string): { chainId: number; targets: WatchTarget[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as DeploymentArtifact;
  for (const [key, val] of Object.entries({
    receipts: raw.receipts,
    spendIntentRegistry: raw.spendIntentRegistry,
  })) {
    if (!val || !isAddress(val)) throw new Error(`artifact ${path}: "${key}" is missing or not an address`);
  }
  return { chainId: raw.chainId, targets: loadTargets(raw) };
}
