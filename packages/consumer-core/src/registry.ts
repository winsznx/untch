/**
 * The provider registry — the gate between "a provider exists in the catalogue" and "this provider
 * may spend real money on a production route".
 *
 * The maturity ladder is the honesty mechanism of the whole Consumer Pack:
 *
 *   verified     — a real settled payment from an Untch treasury wallet has been observed AND its
 *                  delivery was verified. Only these execute on a production route.
 *   sandbox      — adapter implemented, schemas validated against the live spec, protocol shape read
 *                  from a real 402. NO live settlement has ever occurred.
 *   experimental — reachable but a required leg is unverified (a SIWX identity we do not hold, a rail
 *                  we cannot settle, a non-idempotent flow with unconfirmed semantics).
 *   disabled     — not integrated. Cannot be selected at all.
 *
 * `assertExecutable` is the only door, and it refuses anything below `verified` unless an operator
 * has explicitly set CONSUMER_ALLOW_SANDBOX_EXECUTION=1 — which is loudly logged, surfaced in the UI,
 * and stamped onto the intent so a receipt can never imply a provider was verified when it was not.
 *
 * A capability may be LESS mature than its provider (StableDomains can be sandbox for `check` while
 * its `dns` capability is experimental because it needs a SIWX identity). It may never be MORE
 * mature — `effectiveMaturity` takes the minimum, so a capability row cannot be used to quietly
 * promote a provider.
 */

import type { AssetRef, CaipChainId } from "./assets";
import { ProviderError, normalizedError } from "./errors";
import { checkExecutionFlags, loadConsumerFlags, type ConsumerFlags } from "./flags";
import {
  DEFAULT_CAPABILITY_EXECUTION_SHAPE,
  isCapabilityExecutionShape,
  type CapabilityAccessBlocker,
  type CapabilityExecutionShape,
  type ConsumerStore,
  type PauseFlag,
  type ProviderCapabilityRecord,
  type ProviderMaturity,
  type ProviderRecord,
} from "./repo";

const ORDER: Readonly<Record<ProviderMaturity, number>> = Object.freeze({
  disabled: 0,
  experimental: 1,
  sandbox: 2,
  verified: 3,
});

export function compareMaturity(a: ProviderMaturity, b: ProviderMaturity): number {
  return ORDER[a] - ORDER[b];
}

export function maturityAtLeast(actual: ProviderMaturity, floor: ProviderMaturity): boolean {
  return ORDER[actual] >= ORDER[floor];
}

/**
 * The PUBLIC name for a tool's state — what a catalogue, a dashboard, a doc page and the OKX.AI
 * registration draft all show.
 *
 * It is a projection of the internal ladder, never a second source of truth, and never an input to
 * the execution gate. `assertExecutable` reads `maturity`; nothing reads this. That direction is the
 * whole point: a label cannot be edited into permission.
 *
 *   LIVE                     — a real settled payment from an Untch treasury was observed AND the
 *                              delivery was verified. The only state that executes on production.
 *   BETA                     — implemented and validated against the live contract; no settlement yet.
 *   SANDBOX                  — reachable, but a leg is unproven and the work to prove it is ours.
 *   PARTNER_ACCESS_REQUIRED  — blocked by something outside Untch: a partner agreement, an identity
 *                              we do not hold, a rail we cannot sign for, or an operation the
 *                              provider does not offer.
 *   DISABLED                 — not integrated, or switched off. Cannot be selected at all.
 */
export type PublicToolState =
  | "LIVE"
  | "BETA"
  | "SANDBOX"
  | "PARTNER_ACCESS_REQUIRED"
  | "DISABLED";

/**
 * Derive the public state for one tool.
 *
 * A blocker only downgrades. `verified` with a stale blocker string still reads LIVE, because a
 * settled payment plus a verified delivery is evidence and a leftover annotation is not — and the
 * inverse (a label that could suppress a proven capability) would be a control nobody could audit.
 */
export function publicToolState(
  effectiveMaturity: ProviderMaturity,
  accessBlocker: CapabilityAccessBlocker | null | undefined = null,
  /**
   * Whether execution is CONTINUOUSLY available, or needs an operator to arm it first.
   *
   * This is what separates LIVE from BETA, and the distinction is not cosmetic. `verified` is a claim
   * about EVIDENCE: a real payment settled and a real delivery was observed. LIVE is a claim about
   * AVAILABILITY: someone can call this now and it will work. Purch shop.search satisfies the first and
   * not the second, because its treasury signer is removed after every bounded run, so a caller
   * arriving between runs finds nothing that can pay.
   *
   * Collapsing the two would publish LIVE for a capability that is switched off almost all of the time,
   * which is the kind of claim that is technically traceable to a real settlement and still misleads
   * every person who reads it.
   *
   * Defaults true so existing callers keep their meaning. It never feeds the execution gate: this is a
   * label, and `assertExecutable` still reads `maturity` alone.
   */
  standingExecution = true,
): PublicToolState {
  switch (effectiveMaturity) {
    case "verified":
      return standingExecution ? "LIVE" : "BETA";
    case "sandbox":
      return "BETA";
    case "experimental":
      return accessBlocker ? "PARTNER_ACCESS_REQUIRED" : "SANDBOX";
    case "disabled":
      return "DISABLED";
  }
}

/** The public state of a capability under its provider, with the min() rule already applied. */
export function publicToolStateFor(
  provider: ProviderRecord,
  capability: ProviderCapabilityRecord,
  standingExecution = true,
): PublicToolState {
  if (!provider.enabled) return "DISABLED";
  return publicToolState(
    ProviderRegistry.effectiveMaturity(provider, capability),
    capability.accessBlocker ?? null,
    standingExecution,
  );
}

/**
 * Does this chain have a signer that is available WITHOUT an operator arming step?
 *
 * Derived from configuration rather than stored, so the public label cannot drift from the deployment
 * it describes. A proof-mode instance reads as NOT standing on purpose: proof mode exists to authorise
 * exactly one bounded intent, which is the opposite of ordinary availability.
 *
 * Base is standing whenever its treasury key is configured, because nothing removes it between calls.
 */
export function railHasStandingSigner(
  chain: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const on = (v: string | undefined): boolean => v?.trim() === "1" || v?.trim().toLowerCase() === "true";

  if (chain.startsWith("solana:")) {
    if (on(env.CONSUMER_SOLANA_PROOF_MODE)) return false;
    return Boolean(env.CONSUMER_TREASURY_SOLANA_SECRET_KEY?.trim()) && on(env.CONSUMER_SOLANA_EXECUTION_ENABLED);
  }
  if (chain === "eip155:8453") return Boolean(env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim());
  return false;
}

/**
 * Is a signing key configured for this rail AT ALL — armed proof or not?
 *
 * Deliberately a different question from `railHasStandingSigner`, and the difference is load-bearing.
 * That function answers "is this rail ordinarily available", so it reports FALSE during proof mode
 * because a bounded one-shot authority is not ordinary availability. That is the right answer for a
 * public maturity label and the wrong answer for readiness: an operator asking "can this deployment
 * sign at all" during an armed proof needs `true`, and reusing the label would tell them the signer
 * they had just installed was absent.
 *
 * Neither function reads a key. Both only ask whether one is present, which is why they are safe to
 * call from a route that renders its answer into a response body.
 */
export function railSignerConfigured(
  chain: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (chain.startsWith("solana:")) return Boolean(env.CONSUMER_TREASURY_SOLANA_SECRET_KEY?.trim());
  if (chain === "eip155:8453") return Boolean(env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim());
  return false;
}

/**
 * Has the rail's own execution switch been thrown?
 *
 * Only Solana has one. It exists because a Solana payment is BROADCAST BY A THIRD PARTY — the
 * provider's sponsor pays the fee and submits — so "may this rail sign at all" is a question the
 * chain and asset flags do not answer. Base has no such switch and returns true here; its chain and
 * asset flags are the whole of its gating, and inventing a phantom Base switch would make this
 * function report a control that no code enforces.
 */
/**
 * The shape a capability is bought in, resolved rather than read raw.
 *
 * One function, so the default lives in one place. A caller that reached for
 * `capability.executionShape` directly would get `undefined` for every row written before migration 013
 * and would have to remember what that meant — and the two callers who forgot would disagree.
 */
export function resolveExecutionShape(
  capability: Pick<ProviderCapabilityRecord, "executionShape"> | null | undefined,
): CapabilityExecutionShape {
  const declared = capability?.executionShape ?? null;
  return isCapabilityExecutionShape(declared) ? declared : DEFAULT_CAPABILITY_EXECUTION_SHAPE;
}

export function railExecutionEnabled(
  chain: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!chain.startsWith("solana:")) return true;
  const raw = env.CONSUMER_SOLANA_EXECUTION_ENABLED?.trim();
  return raw === "1" || raw?.toLowerCase() === "true";
}

export interface MaturityGate {
  /** The floor a production execution route requires. Always "verified". Not configurable. */
  readonly executionFloor: ProviderMaturity;
  /** Whether a `sandbox` provider may execute anyway. Operator-set, loudly reported. */
  readonly allowSandboxExecution: boolean;
}

export interface RegistryDeps {
  readonly store: ConsumerStore;
  readonly gate: MaturityGate;
  /** The environment switches. Omitted ⇒ read from process.env, which defaults everything OFF. */
  readonly flags?: ConsumerFlags;
  readonly clock?: () => number;
  /** Surfaces a sandbox execution to the operator. Wired to the alert channel by the ASP. */
  readonly onSandboxExecution?: (providerId: string, capability: string) => void;
}

export interface ResolvedProvider {
  readonly provider: ProviderRecord;
  readonly capability: ProviderCapabilityRecord;
  readonly effectiveMaturity: ProviderMaturity;
  /** True when this execution is proceeding under the sandbox escape hatch. Stamped on the intent. */
  readonly sandboxOverride: boolean;
}

export class ProviderRegistry {
  private readonly store: ConsumerStore;
  private readonly gate: MaturityGate;
  private readonly flags: ConsumerFlags;
  private readonly clock: () => number;
  private readonly onSandboxExecution: (providerId: string, capability: string) => void;

  constructor(deps: RegistryDeps) {
    this.store = deps.store;
    this.gate = deps.gate;
    this.flags = deps.flags ?? loadConsumerFlags();
    this.clock = deps.clock ?? Date.now;
    this.onSandboxExecution = deps.onSandboxExecution ?? (() => {});
  }

  /**
   * The FLAG half of the execution gate — has an operator switched this combination on?
   *
   * Deliberately separate from `assertExecutable`, which asks whether the provider has EARNED the
   * right to execute. Both must pass, and neither can substitute for the other: a flag is
   * permission, maturity is proof, and conflating them is how a switch ends up meaning "this works".
   */
  assertFlagsAllow(providerId: string, chain: CaipChainId, asset: AssetRef): void {
    const result = checkExecutionFlags(this.flags, { providerId, chain, asset });
    if (!result.allowed) {
      throw new ProviderError(
        normalizedError("PROVIDER_NOT_EXECUTABLE", result.detail, { providerCode: result.reason }),
      );
    }
  }

  /** The lower of the provider's and the capability's maturity. Never the higher. */
  static effectiveMaturity(
    provider: ProviderRecord,
    capability: ProviderCapabilityRecord,
  ): ProviderMaturity {
    return compareMaturity(provider.maturity, capability.maturity) <= 0
      ? provider.maturity
      : capability.maturity;
  }

  async listEnabled(): Promise<readonly ProviderRecord[]> {
    const all = await this.store.listProviders();
    return all.filter((p) => p.enabled && p.maturity !== "disabled");
  }

  /**
   * Every provider that declares `capability` at or above `floor`, best-maturity first. Used by
   * discovery, which may legitimately read from a sandbox provider — reading costs nothing and
   * commits nothing.
   */
  async providersFor(
    capability: string,
    floor: ProviderMaturity = "experimental",
  ): Promise<readonly ResolvedProvider[]> {
    const out: ResolvedProvider[] = [];
    for (const provider of await this.listEnabled()) {
      const caps = await this.store.listCapabilities(provider.providerId);
      const cap = caps.find((c) => c.capability === capability);
      if (!cap) continue;
      const effectiveMaturity = ProviderRegistry.effectiveMaturity(provider, cap);
      if (!maturityAtLeast(effectiveMaturity, floor)) continue;
      out.push({ provider, capability: cap, effectiveMaturity, sandboxOverride: false });
    }
    out.sort((a, b) => compareMaturity(b.effectiveMaturity, a.effectiveMaturity));
    return out;
  }

  /**
   * The gate for anything that MOVES MONEY. Throws a typed ProviderError rather than returning a
   * boolean, because every caller of this must stop, and a boolean invites a caller that forgets to
   * check it.
   */
  async assertExecutable(providerId: string, capability: string): Promise<ResolvedProvider> {
    const provider = await this.store.getProvider(providerId);
    if (!provider) {
      throw new ProviderError(
        normalizedError("PROVIDER_NOT_EXECUTABLE", `no provider ${providerId} in the registry`),
      );
    }
    if (!provider.enabled) {
      throw new ProviderError(
        normalizedError("PROVIDER_NOT_EXECUTABLE", `provider ${providerId} is disabled`),
      );
    }
    const caps = await this.store.listCapabilities(providerId);
    const cap = caps.find((c) => c.capability === capability);
    if (!cap) {
      throw new ProviderError(
        normalizedError(
          "CAPABILITY_UNAVAILABLE",
          `provider ${providerId} does not declare capability ${capability}`,
        ),
      );
    }

    const effectiveMaturity = ProviderRegistry.effectiveMaturity(provider, cap);

    if (maturityAtLeast(effectiveMaturity, this.gate.executionFloor)) {
      return { provider, capability: cap, effectiveMaturity, sandboxOverride: false };
    }

    // Below the floor. The ONLY escape is an explicit operator opt-in, and only from `sandbox` —
    // `experimental` and `disabled` are never executable by any configuration.
    if (effectiveMaturity === "sandbox" && this.gate.allowSandboxExecution) {
      this.onSandboxExecution(providerId, capability);
      return { provider, capability: cap, effectiveMaturity, sandboxOverride: true };
    }

    throw new ProviderError(
      normalizedError(
        "PROVIDER_NOT_EXECUTABLE",
        `provider ${providerId} capability ${capability} is '${effectiveMaturity}', below the required ` +
          `'${this.gate.executionFloor}'` +
          (effectiveMaturity === "sandbox"
            ? " — set CONSUMER_ALLOW_SANDBOX_EXECUTION=1 to execute against a sandbox provider in a " +
              "non-production environment; it will be recorded on the intent and the receipt"
            : " — promotion requires a real observed settlement, which cannot be configured around"),
      ),
    );
  }

  /** A provider's circuit breaker. OPEN refuses immediately; HALF_OPEN admits one probe. */
  async assertCircuitClosed(providerId: string, cooldownMs: number): Promise<void> {
    const health = await this.store.latestHealth(providerId);
    if (!health || health.breakerState === "CLOSED") return;
    if (health.breakerState === "HALF_OPEN") return;
    const openedAt = Date.parse(health.observedAt);
    if (Number.isFinite(openedAt) && this.clock() - openedAt >= cooldownMs) return;
    throw new ProviderError(
      normalizedError(
        "CIRCUIT_OPEN",
        `provider ${providerId} circuit is open: ${health.detail}`,
        { retryAfterMs: cooldownMs },
      ),
    );
  }
}

/**
 * The kill-switch evaluator. One query, four scopes, checked in order of blast radius so the most
 * severe reason is the one reported.
 */
export function firstEngagedPause(
  flags: readonly PauseFlag[],
  scope: { readonly providerId?: string; readonly chain?: string; readonly assetKey?: string; readonly treasuryRef?: string },
): PauseFlag | null {
  const engaged = flags.filter((f) => f.paused);
  const global = engaged.find((f) => f.scope === "GLOBAL");
  if (global) return global;
  if (scope.chain !== undefined) {
    const hit = engaged.find((f) => f.scope === "CHAIN" && f.target === scope.chain);
    if (hit) return hit;
  }
  if (scope.assetKey !== undefined) {
    const hit = engaged.find((f) => f.scope === "ASSET" && f.target === scope.assetKey);
    if (hit) return hit;
  }
  if (scope.providerId !== undefined) {
    const hit = engaged.find((f) => f.scope === "PROVIDER" && f.target === scope.providerId);
    if (hit) return hit;
  }
  if (scope.treasuryRef !== undefined) {
    const hit = engaged.find((f) => f.scope === "TREASURY_ACCOUNT" && f.target === scope.treasuryRef);
    if (hit) return hit;
  }
  return null;
}
