/**
 * Consumer Pack feature flags — the switches that decide what this instance is allowed to do.
 *
 * The governing rule is that EXECUTION IS OFF UNLESS EVERY SWITCH SAYS OTHERWISE. Discovery,
 * quoting and status are a separate, weaker gate: reading a merchant's catalogue commits nothing,
 * so it is reasonable to run those while execution stays dark. Spending is not.
 *
 * Parsing is deliberately strict and fail-closed. Only the exact strings "1" and "true" (case
 * -insensitive, trimmed) enable anything. A typo, an empty string, the literal "false", "yes",
 * "on", or an unset variable all mean OFF. A flag layer that guessed generously would be a flag
 * layer that turned itself on during a config mistake.
 *
 * There is deliberately NO flag that can make a provider executable on its own. Credentials
 * existing is not permission; a flag being true is not proof. `ExecutionGate` below requires ALL
 * of: verified maturity, the provider enabled in BOTH the registry and the environment, execution
 * enabled globally, the chain enabled, the asset enabled, and a healthy treasury account. Any one
 * of those missing is a refusal with a named reason.
 */

import type { AssetRef, CaipChainId } from "./assets";
import { assetKey, describeAsset } from "./assets";

/** Fail-closed boolean. Only "1" and "true" enable; everything else — including junk — is off. */
export function flagOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const t = raw.trim().toLowerCase();
  return t === "1" || t === "true";
}

/** Normalise a providerId into the env-var fragment: `stabledomains` → `STABLEDOMAINS`. */
export function providerFlagName(providerId: string): string {
  return `CONSUMER_PROVIDER_${providerId.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ENABLED`;
}

/** Normalise a CAIP-2 chain into the env-var fragment: `eip155:8453` → `EIP155_8453`. */
export function chainFlagName(chain: CaipChainId): string {
  return `CONSUMER_CHAIN_${chain.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ENABLED`;
}

/** `USDC` on `eip155:8453` → `CONSUMER_ASSET_EIP155_8453_USDC_ENABLED`. */
export function assetFlagName(asset: AssetRef): string {
  const chain = asset.chain.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const token = asset.symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `CONSUMER_ASSET_${chain}_${token}_ENABLED`;
}

export interface ConsumerFlags {
  /** Master switch. OFF ⇒ every consumer route answers 503, including the read-only ones. */
  readonly packEnabled: boolean;
  /** The spend switch. OFF ⇒ discovery/quote/status work; nothing may execute. Defaults OFF. */
  readonly executionEnabled: boolean;
  /** The live smoke driver's own switch. Never true in a normal deployment. */
  readonly liveSmokeEnabled: boolean;
  providerEnabled(providerId: string): boolean;
  chainEnabled(chain: CaipChainId): boolean;
  assetEnabled(asset: AssetRef): boolean;
  /** Every flag, for the operator surface and the boot log. Values are booleans, never secrets. */
  snapshot(providerIds: readonly string[]): Readonly<Record<string, boolean>>;
}

export function loadConsumerFlags(env: NodeJS.ProcessEnv = process.env): ConsumerFlags {
  const packEnabled = flagOn(env.CONSUMER_PACK_ENABLED);
  const executionEnabled = flagOn(env.CONSUMER_EXECUTION_ENABLED);
  const liveSmokeEnabled = flagOn(env.CONSUMER_LIVE_SMOKE_ENABLED);

  return {
    packEnabled,
    executionEnabled,
    liveSmokeEnabled,
    providerEnabled: (providerId) => flagOn(env[providerFlagName(providerId)]),
    /**
     * A chain with no flag is OFF. That is why X Layer — the FUNDING rail, not a settlement rail —
     * has to be enabled explicitly too: there is no implicit trust for "the chain we already use".
     */
    chainEnabled: (chain) => flagOn(env[chainFlagName(chain)]),
    /**
     * An asset with no flag falls back to its CHAIN's flag. Enumerating every token would make
     * adding one a two-variable change that is easy to half-do; the asset flag exists to DENY a
     * specific token on an otherwise-enabled chain, which is the case that actually arises.
     */
    assetEnabled: (asset) => {
      const explicit = env[assetFlagName(asset)];
      if (explicit !== undefined) return flagOn(explicit);
      return flagOn(env[chainFlagName(asset.chain)]);
    },
    snapshot: (providerIds) => {
      const out: Record<string, boolean> = {
        CONSUMER_PACK_ENABLED: packEnabled,
        CONSUMER_EXECUTION_ENABLED: executionEnabled,
        CONSUMER_LIVE_SMOKE_ENABLED: liveSmokeEnabled,
      };
      for (const id of providerIds) out[providerFlagName(id)] = flagOn(env[providerFlagName(id)]);
      return out;
    },
  };
}

/** Every reason an execution can be refused. Each maps to one gate, so a refusal names its cause. */
export type ExecutionBlockReason =
  | "PACK_DISABLED"
  | "EXECUTION_DISABLED"
  | "PROVIDER_FLAG_DISABLED"
  | "CHAIN_DISABLED"
  | "ASSET_DISABLED";

export interface GateInput {
  readonly providerId: string;
  readonly chain: CaipChainId;
  readonly asset: AssetRef;
}

export interface GateResult {
  readonly allowed: boolean;
  readonly reason: ExecutionBlockReason | null;
  readonly detail: string;
}

/**
 * The flag half of the execution gate.
 *
 * It deliberately does NOT check maturity, treasury health, policy, quote or funding — those live
 * in `ProviderRegistry`, `TreasuryRouter` and the orchestrator, and each refuses on its own. This
 * function answers exactly one question: has an operator switched this combination on? Keeping the
 * halves separate is what stops a flag from ever being mistaken for proof that a provider works.
 */
export function checkExecutionFlags(flags: ConsumerFlags, input: GateInput): GateResult {
  if (!flags.packEnabled) {
    return {
      allowed: false,
      reason: "PACK_DISABLED",
      detail: "CONSUMER_PACK_ENABLED is not set — the Consumer Pack is off on this instance",
    };
  }
  if (!flags.executionEnabled) {
    return {
      allowed: false,
      reason: "EXECUTION_DISABLED",
      detail:
        "CONSUMER_EXECUTION_ENABLED is not set — discovery, quoting and status are available, but " +
        "nothing may spend. This is the default and is not an error.",
    };
  }
  if (!flags.providerEnabled(input.providerId)) {
    return {
      allowed: false,
      reason: "PROVIDER_FLAG_DISABLED",
      detail: `${providerFlagName(input.providerId)} is not set — this provider is switched off`,
    };
  }
  if (!flags.chainEnabled(input.chain)) {
    return {
      allowed: false,
      reason: "CHAIN_DISABLED",
      detail: `${chainFlagName(input.chain)} is not set — settlement on ${input.chain} is switched off`,
    };
  }
  if (!flags.assetEnabled(input.asset)) {
    return {
      allowed: false,
      reason: "ASSET_DISABLED",
      detail: `${assetFlagName(input.asset)} is not set — ${describeAsset(input.asset)} is switched off`,
    };
  }
  return { allowed: true, reason: null, detail: `${assetKey(input.asset)} enabled for ${input.providerId}` };
}

/** A one-line boot summary. Booleans only — this is safe to log and safe to show an operator. */
export function describeFlags(flags: ConsumerFlags, providerIds: readonly string[]): string {
  const snap = flags.snapshot(providerIds);
  const on = Object.entries(snap).filter(([, v]) => v).map(([k]) => k);
  return on.length === 0
    ? "all Consumer Pack flags OFF (execution impossible)"
    : `Consumer Pack flags ON: ${on.join(", ")}`;
}
