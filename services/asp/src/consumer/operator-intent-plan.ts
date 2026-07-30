/**
 * The operator intent PLAN — what production would do with a request, worked out without doing it.
 *
 * WHY THIS EXISTS
 *
 * The bounded Purch proof needs one intent, named in advance, created in production, executed by the
 * deployed worker. Until now the only way to reach that shape was `pnpm consumer:smoke:live`, which
 * reaches production by holding production's own `DATABASE_URL`. That makes the local script a
 * production component: it writes registry rows, it constructs a treasury signer, it supplies its own
 * in-process policy, and every control the deployed service enforces becomes advisory because a
 * process with write access to the store can step around all of them. The evidence such a run
 * produces is evidence about the script, not about production.
 *
 * So the boundary moved to HTTP. The controller sends a bounded request to the deployed ASP and the
 * ASP answers out of its OWN store, its OWN registry, its OWN flags and its OWN policy provider. The
 * controller needs no database credential, no signer and no provider secret — which is the point:
 * a credential that is never issued cannot be misused.
 *
 * WHAT THIS MODULE IS
 *
 * Everything the two operator routes decide, as pure functions over a store. It is deliberately not
 * express-aware, so the decisions can be tested without a socket, and deliberately READ-ONLY: there
 * is not a single write in this file, and the tests assert that by handing it a store whose writes
 * throw.
 *
 * WHAT IS DERIVED, AND WHY THAT LIST MATTERS
 *
 * The caller may not name a provider URL, a recipient, a token mint, a chain, a rail or a treasury.
 * Each of those is read from production configuration or the production registry instead. A route
 * that accepted them would be a route that could be pointed at an attacker's address by whoever
 * holds the operator token, which would make the token equivalent to the treasury key. It is not,
 * and this list is what keeps that true.
 */

import {
  ProviderRegistry,
  compareMaturity,
  confirmedAssetsFor,
  formatMoney,
  gtMoney,
  isConsumerActionType,
  isIntentId,
  loadSolanaProofGate,
  maturityAtLeast,
  normalizeIdempotencyKey,
  parseMoney,
  publicToolStateFor,
  railHasStandingSigner,
  checkExecutionFlags,
  asset as assetByKey,
  type AssetRef,
  type CaipChainId,
  type ConsumerActionType,
  type ConsumerFlags,
  type ConsumerStore,
  type ExecutionPolicyConfig,
  type Money,
  type ProviderMaturity,
  type PublicToolState,
} from "@untch/consumer-core";
import type { PolicyProvider } from "@untch/policy-store";

/** The funding modes an operator route accepts. Anything else is a refusal, never a default. */
export const OPERATOR_FUNDING_MODES = ["operator-funded", "externally-funded"] as const;
export type OperatorFundingMode = (typeof OPERATOR_FUNDING_MODES)[number];

export interface OperatorIntentInput {
  /** Caller-supplied and EXACT. The proof gate has to name it before production is armed. */
  readonly intentId: string;
  readonly tenantId: string;
  /** The owner, or the operator identity funding on an owner's behalf. Recorded, never authorising. */
  readonly owner: string;
  readonly provider: string;
  readonly capability: ConsumerActionType;
  readonly request: Readonly<Record<string, unknown>>;
  /**
   * The MERCHANT's own reference for the thing being bought — an ASIN, a domain, a search label.
   *
   * Required by `ConsumerOrchestrator.quote`, which passes it to the adapter. It is deliberately NOT
   * a URL on this route: some adapters treat a `https://` reference as a product URL, and a route
   * that let an operator hand a provider an arbitrary URL would be a route whose token could point
   * a purchase at somewhere the registry never named. Defaults to the capability, which is what a
   * self-quoting paid read (a search, a check) actually references.
   */
  readonly providerRef: string;
  /** The ceiling on what the PROVIDER may charge, in the settlement asset. A refusal, not a clamp. */
  readonly maxProviderAmountRaw: string;
  readonly expectedSettlementChain: CaipChainId;
  readonly expectedSettlementAsset: string;
  readonly fundingMode: OperatorFundingMode;
  readonly idempotencyKey: string;
  readonly expiresAt: string | null;
}

export interface Refusal {
  readonly code: string;
  readonly message: string;
}

export interface OperatorDeploymentIdentity {
  readonly phase: string;
  readonly commit: string | null;
  readonly commitShort: string | null;
  readonly attested: boolean;
  readonly deploymentId: string | null;
  readonly migrationVersion: string | null;
  readonly environment: string | null;
  readonly productionStore: boolean;
  readonly proofGateSchemaReady: boolean;
}

export interface OperatorIntentPlan {
  readonly accepted: boolean;
  readonly intentId: string;
  readonly provider: string;
  readonly capability: string;
  readonly action: ConsumerActionType;
  readonly productionMaturity: {
    readonly provider: ProviderMaturity | null;
    readonly capability: ProviderMaturity | null;
    readonly effective: ProviderMaturity | null;
    readonly providerEnabled: boolean;
  };
  readonly publicMaturity: PublicToolState | null;
  readonly expectedPolicyPath: {
    readonly tenantId: string;
    readonly policyId: string | null;
    readonly source: "policy-store";
    readonly found: boolean;
    readonly status: string | null;
  };
  readonly expectedSettlement: {
    readonly chain: CaipChainId | null;
    readonly assetSymbol: string | null;
    readonly treasuryRef: string | null;
    readonly treasuryConfigured: boolean;
    readonly treasuryEnabled: boolean;
    readonly standingSigner: boolean;
  };
  readonly maxAuthorisedAmount: string | null;
  readonly executionFloor: {
    readonly required: ProviderMaturity;
    readonly effective: ProviderMaturity | null;
    readonly satisfied: boolean;
  };
  /** The standing switches, as booleans. Never a value, never a name that carries one. */
  readonly executionControls: {
    readonly packEnabled: boolean;
    readonly executionEnabled: boolean;
    readonly providerEnabled: boolean;
    readonly chainEnabled: boolean;
    readonly assetEnabled: boolean;
    readonly flagRefusal: string | null;
  };
  readonly proofGate: {
    readonly governsThisChain: boolean;
    readonly mode: "enabled" | "disabled";
    readonly compatible: boolean;
    readonly reasons: readonly string[];
  };
  readonly fundingMode: OperatorFundingMode;
  readonly idempotency: { readonly keyAccepted: boolean; readonly duplicate: boolean };
  readonly deployment: OperatorDeploymentIdentity;
  readonly refusals: readonly Refusal[];
}

export interface PlanDeps {
  readonly store: ConsumerStore;
  readonly registry: ProviderRegistry;
  readonly policyProvider: PolicyProvider;
  readonly flags: ConsumerFlags;
  readonly config: ExecutionPolicyConfig;
  readonly deployment: OperatorDeploymentIdentity;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

// ── input parsing ────────────────────────────────────────────────────────────

const MAX_REQUEST_BYTES = 8 * 1024;

function str(body: Record<string, unknown>, field: string): string | null {
  const v = body[field];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Parse the wire body into the input, or say precisely which field is wrong.
 *
 * Every failure here is a REFUSAL with a code, not a thrown error. An operator debugging a proof at
 * the moment production is about to be armed needs to be told which of eleven fields was rejected,
 * and a 400 with "bad request" would send them to read this file instead.
 */
export function parseOperatorIntentInput(
  body: unknown,
): { readonly ok: true; readonly input: OperatorIntentInput } | { readonly ok: false; readonly refusals: readonly Refusal[] } {
  const refusals: Refusal[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, refusals: [{ code: "BAD_BODY", message: "the request body must be a JSON object" }] };
  }
  const b = body as Record<string, unknown>;

  const intentId = str(b, "intentId");
  if (intentId === null) refusals.push({ code: "INTENT_ID_MISSING", message: "`intentId` is required — the operator route never mints one" });
  else if (!isIntentId(intentId)) {
    refusals.push({
      code: "INTENT_ID_MALFORMED",
      message: "`intentId` must match the canonical form ci_ followed by 24 lowercase hex characters",
    });
  }

  const tenantId = str(b, "tenantId");
  if (tenantId === null) refusals.push({ code: "TENANT_ID_MISSING", message: "`tenantId` is required" });
  else if (!/^policy:[A-Za-z0-9._:-]{1,80}$/.test(tenantId)) {
    refusals.push({
      code: "TENANT_ID_MALFORMED",
      message: "`tenantId` must be `policy:<policyId>` — the tenant IS the policy partition",
    });
  }

  const owner = str(b, "owner");
  if (owner === null) refusals.push({ code: "OWNER_MISSING", message: "`owner` is required — an intent with no owner has no one to answer to" });

  const provider = str(b, "provider");
  if (provider === null) refusals.push({ code: "PROVIDER_MISSING", message: "`provider` is required" });
  else if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(provider)) {
    refusals.push({ code: "PROVIDER_MALFORMED", message: "`provider` must be a registry provider id" });
  }

  const capabilityRaw = str(b, "capability");
  if (capabilityRaw === null) refusals.push({ code: "CAPABILITY_MISSING", message: "`capability` is required" });
  else if (!isConsumerActionType(capabilityRaw)) {
    refusals.push({
      code: "CAPABILITY_UNKNOWN",
      message: `'${capabilityRaw}' is not a Consumer Pack action type`,
    });
  }

  const request = b.request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    refusals.push({ code: "REQUEST_MALFORMED", message: "`request` must be a JSON object" });
  } else if (JSON.stringify(request).length > MAX_REQUEST_BYTES) {
    refusals.push({ code: "REQUEST_TOO_LARGE", message: `\`request\` must be under ${MAX_REQUEST_BYTES} bytes` });
  }

  const providerRefRaw = b.providerRef === undefined ? null : str(b, "providerRef");
  if (b.providerRef !== undefined && providerRefRaw === null) {
    refusals.push({ code: "PROVIDER_REF_MALFORMED", message: "`providerRef` must be a non-empty string" });
  } else if (providerRefRaw !== null && (providerRefRaw.length > 512 || /:\/\//.test(providerRefRaw))) {
    refusals.push({
      code: "PROVIDER_REF_MALFORMED",
      message: "`providerRef` must be under 512 characters and may not be a URL",
    });
  }

  const maxProviderAmountRaw = str(b, "maxProviderAmount");
  if (maxProviderAmountRaw === null) {
    refusals.push({
      code: "MAX_AMOUNT_MISSING",
      message: "`maxProviderAmount` is required — an operator-created intent always carries an explicit ceiling",
    });
  }

  const expectedSettlementChain = str(b, "expectedSettlementChain");
  if (expectedSettlementChain === null) {
    refusals.push({ code: "SETTLEMENT_CHAIN_MISSING", message: "`expectedSettlementChain` is required (CAIP-2)" });
  }

  const expectedSettlementAsset = str(b, "expectedSettlementAsset");
  if (expectedSettlementAsset === null) {
    refusals.push({ code: "SETTLEMENT_ASSET_MISSING", message: "`expectedSettlementAsset` is required (the token symbol)" });
  }

  const fundingModeRaw = str(b, "fundingMode");
  const fundingMode = OPERATOR_FUNDING_MODES.find((m) => m === fundingModeRaw) ?? null;
  if (fundingMode === null) {
    refusals.push({
      code: "FUNDING_MODE_INVALID",
      message: `\`fundingMode\` must be one of ${OPERATOR_FUNDING_MODES.join(", ")}`,
    });
  }

  const idempotencyKey = normalizeIdempotencyKey(b.idempotencyKey);
  if (idempotencyKey === null) {
    refusals.push({
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "`idempotencyKey` must be 8-200 characters of [A-Za-z0-9._:-]",
    });
  }

  let expiresAt: string | null = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    const raw = str(b, "expiresAt");
    if (raw === null || Number.isNaN(Date.parse(raw))) {
      refusals.push({ code: "EXPIRY_INVALID", message: "`expiresAt` must be an ISO 8601 timestamp" });
    } else {
      expiresAt = new Date(Date.parse(raw)).toISOString();
    }
  }

  // Fields a caller must NOT be able to supply. Rejecting them loudly is better than ignoring them:
  // a controller that thinks it pinned a recipient and was silently overruled would report a
  // guarantee it never had.
  for (const forbidden of [
    "providerUrl",
    "baseUrl",
    "recipient",
    "payTo",
    "settlementRecipient",
    "tokenMint",
    "assetAddress",
    "treasury",
    "treasuryRef",
    "treasuryAddress",
    "rail",
    "paymentRail",
    "chainConfig",
    "maturity",
    "providerMaturity",
  ]) {
    if (b[forbidden] !== undefined) {
      refusals.push({
        code: "FIELD_NOT_ACCEPTED",
        message: `\`${forbidden}\` is derived from production configuration and may not be supplied`,
      });
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };

  // Every branch above pushed a refusal for a null, so the non-null assertions the compiler needs
  // here are the narrowing it cannot see through. Written as explicit checks rather than `!`.
  if (
    intentId === null || tenantId === null || owner === null || provider === null ||
    capabilityRaw === null || !isConsumerActionType(capabilityRaw) ||
    maxProviderAmountRaw === null || expectedSettlementChain === null ||
    expectedSettlementAsset === null || fundingMode === null || idempotencyKey === null ||
    typeof request !== "object" || request === null || Array.isArray(request)
  ) {
    return { ok: false, refusals: [{ code: "BAD_BODY", message: "the request body is incomplete" }] };
  }

  return {
    ok: true,
    input: {
      intentId,
      tenantId,
      owner,
      provider,
      capability: capabilityRaw,
      request: request as Readonly<Record<string, unknown>>,
      providerRef: providerRefRaw ?? capabilityRaw,
      maxProviderAmountRaw,
      expectedSettlementChain: expectedSettlementChain as CaipChainId,
      expectedSettlementAsset,
      fundingMode,
      idempotencyKey,
      expiresAt,
    },
  };
}

// ── the plan ─────────────────────────────────────────────────────────────────

/**
 * Assemble the plan. Reads production state; writes nothing.
 *
 * The order is chosen so the cheapest and most conclusive refusals come first, and so a refusal
 * never depends on a lookup that a previous refusal made meaningless. Every check that CAN run still
 * runs, though — an operator arming a one-shot proof wants the whole list of blockers in one
 * response, not the first one.
 */
export async function planOperatorIntent(
  input: OperatorIntentInput,
  deps: PlanDeps,
): Promise<OperatorIntentPlan> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const refusals: Refusal[] = [];
  const add = (code: string, message: string): void => {
    refusals.push({ code, message });
  };

  // ── deployment identity. A route that cannot prove what it is refuses everything. ──
  const d = deps.deployment;
  if (d.phase !== "READY") add("DEPLOYMENT_NOT_READY", `this instance is ${d.phase}, not READY`);
  if (!d.attested || d.commit === null) {
    add("DEPLOYMENT_UNATTESTED", "this instance carries no build attestation, so its serving commit cannot be proven");
  }
  if (!d.productionStore) {
    add("NOT_PRODUCTION", "this instance is not running in the production environment");
  }
  if (d.migrationVersion === null) {
    add("SCHEMA_UNKNOWN", "this instance could not report its migration version");
  }

  // ── the intent id ──
  const existing = await deps.store.getIntent(input.intentId);
  if (existing) {
    add("INTENT_ID_EXISTS", `intent ${input.intentId} already exists in the production store`);
  }

  // ── idempotency ──
  const duplicate = await deps.store.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
  if (duplicate && duplicate.intentId !== input.intentId) {
    add(
      "IDEMPOTENCY_KEY_BOUND_ELSEWHERE",
      `this idempotency key already names intent ${duplicate.intentId} in this tenant`,
    );
  }

  // ── provider and capability, from the PRODUCTION registry ──
  const provider = await deps.store.getProvider(input.provider);
  const capabilities = provider ? await deps.store.listCapabilities(input.provider) : [];
  const capability = capabilities.find((c) => c.capability === input.capability) ?? null;

  if (!provider) add("PROVIDER_UNKNOWN", `no provider '${input.provider}' in the production registry`);
  if (provider && !provider.enabled) add("PROVIDER_DISABLED", `provider '${input.provider}' is disabled in the registry`);
  if (provider && !capability) {
    add("CAPABILITY_NOT_DECLARED", `provider '${input.provider}' does not declare '${input.capability}'`);
  }

  const effectiveMaturity =
    provider && capability ? ProviderRegistry.effectiveMaturity(provider, capability) : null;
  const executionFloor: ProviderMaturity = "verified";
  const floorSatisfied =
    effectiveMaturity !== null &&
    (maturityAtLeast(effectiveMaturity, executionFloor) ||
      (effectiveMaturity === "sandbox" && deps.config.allowSandboxExecution));
  if (effectiveMaturity !== null && !floorSatisfied) {
    add(
      "BELOW_EXECUTION_FLOOR",
      `'${input.provider}' x '${input.capability}' is '${effectiveMaturity}', below the required '${executionFloor}'`,
    );
  }

  // ── the settlement rail, DERIVED from the provider's registered chains ──
  const providerChains = provider?.chains ?? [];
  let settlementChain: CaipChainId | null = null;
  if (provider) {
    if (providerChains.length === 0) {
      add("SETTLEMENT_CHAIN_UNDERIVABLE", `provider '${input.provider}' declares no settlement chain`);
    } else if (providerChains.includes(input.expectedSettlementChain)) {
      settlementChain = input.expectedSettlementChain;
    } else {
      add(
        "SETTLEMENT_CHAIN_MISMATCH",
        `provider '${input.provider}' does not settle on ${input.expectedSettlementChain}; ` +
          `the registry names ${providerChains.join(", ")}`,
      );
    }
  }

  // ── the settlement asset, DERIVED from the chain's confirmed asset registry ──
  let settlementAsset: AssetRef | null = null;
  if (settlementChain) {
    const candidates = confirmedAssetsFor(settlementChain).filter(
      (a) => a.symbol.toUpperCase() === input.expectedSettlementAsset.toUpperCase(),
    );
    const chosen = candidates[0];
    if (!chosen) {
      add(
        "SETTLEMENT_ASSET_UNKNOWN",
        `no confirmed '${input.expectedSettlementAsset}' is registered on ${settlementChain}`,
      );
    } else {
      settlementAsset = chosen;
    }
  }

  // ── the ceiling, parsed in the DERIVED asset ──
  let maxAmount: Money | null = null;
  if (settlementAsset) {
    try {
      maxAmount = parseMoney(input.maxProviderAmountRaw, settlementAsset);
    } catch {
      add("MAX_AMOUNT_MALFORMED", "`maxProviderAmount` is not an exact decimal in the settlement asset");
    }
    if (maxAmount && maxAmount.amount <= 0n) {
      add("MAX_AMOUNT_NOT_POSITIVE", "`maxProviderAmount` must be positive");
    }
  }

  // ── the instance's own single-execution ceiling ──
  if (maxAmount && settlementAsset) {
    let instanceCeiling: Money | null = null;
    try {
      instanceCeiling = parseMoney(deps.config.maxSingleExecutionDisplay, settlementAsset);
    } catch {
      instanceCeiling = null;
    }
    if (instanceCeiling && gtMoney(maxAmount, instanceCeiling)) {
      add(
        "ABOVE_INSTANCE_CEILING",
        `${formatMoney(maxAmount)} exceeds this instance's single-execution ceiling of ${formatMoney(instanceCeiling)}`,
      );
    }
  }

  // ── the per-provider limit from the production store ──
  if (maxAmount && settlementAsset && settlementChain && provider) {
    const limit = await deps.store.getProviderLimit(
      input.provider,
      settlementChain,
      settlementAsset.symbol,
    );
    if (limit && gtMoney(maxAmount, limit.perTxMax)) {
      add(
        "ABOVE_PROVIDER_LIMIT",
        `${formatMoney(maxAmount)} exceeds the registered per-transaction limit of ${formatMoney(limit.perTxMax)}`,
      );
    }
  }

  // ── the standing execution controls ──
  const packEnabled = deps.flags.packEnabled;
  const executionEnabled = deps.flags.executionEnabled;
  const providerFlagEnabled = deps.flags.providerEnabled(input.provider);
  const chainEnabled = settlementChain ? deps.flags.chainEnabled(settlementChain) : false;
  const assetEnabled = settlementAsset ? deps.flags.assetEnabled(settlementAsset) : false;
  let flagRefusal: string | null = null;
  if (settlementChain && settlementAsset) {
    const gate = checkExecutionFlags(deps.flags, {
      providerId: input.provider,
      chain: settlementChain,
      asset: settlementAsset,
    });
    if (!gate.allowed) {
      flagRefusal = gate.reason;
      add("EXECUTION_CONTROLS_DISABLED", gate.detail);
    }
  }

  // ── the settlement treasury, DERIVED ──
  let treasuryRef: string | null = null;
  let treasuryEnabled = false;
  if (settlementChain && settlementAsset) {
    const account = await deps.store.findTreasuryAccount(
      settlementChain,
      settlementAsset.symbol,
      "SETTLEMENT",
    );
    if (!account) {
      add(
        "SETTLEMENT_TREASURY_ABSENT",
        `no SETTLEMENT treasury account is registered for ${settlementAsset.symbol} on ${settlementChain}`,
      );
    } else {
      treasuryRef = account.treasuryRef;
      treasuryEnabled = account.enabled;
      if (!account.enabled) {
        add("SETTLEMENT_TREASURY_DISABLED", `treasury account '${account.treasuryRef}' is disabled`);
      }
    }
  }

  const standingSigner = settlementChain ? railHasStandingSigner(settlementChain, env) : false;

  // ── the policy path ──
  const policyId = input.tenantId.startsWith("policy:") ? input.tenantId.slice("policy:".length) : null;
  let policyFound = false;
  let policyStatus: string | null = null;
  if (policyId === null) {
    add("POLICY_PATH_UNDERIVABLE", "the tenant does not name a policy, so no policy path exists");
  } else {
    const stored = await deps.policyProvider.loadStored(policyId);
    if (!stored) {
      add("POLICY_NOT_FOUND", `policy ${policyId} is not in the production policy store`);
    } else {
      policyFound = true;
      policyStatus = String((stored as { status?: unknown }).status ?? "UNKNOWN");
      if (policyStatus !== "ACTIVE") {
        add("POLICY_NOT_ACTIVE", `policy ${policyId} is ${policyStatus}, not ACTIVE`);
      }
    }
  }

  // ── pauses ──
  const pauses = await deps.store.listPauses();
  const engaged = pauses.filter((p) => p.paused);
  for (const pause of engaged) {
    const relevant =
      pause.scope === "GLOBAL" ||
      (pause.scope === "PROVIDER" && pause.target === input.provider) ||
      (pause.scope === "CHAIN" && settlementChain !== null && pause.target === settlementChain) ||
      (pause.scope === "TREASURY_ACCOUNT" && treasuryRef !== null && pause.target === treasuryRef);
    if (relevant) add("PAUSED", `a ${pause.scope} pause is engaged: ${pause.reason}`);
  }

  // ── proof-gate compatibility, where a gate is configured ──
  const governsThisChain = settlementChain !== null && settlementChain.startsWith("solana:");
  const proofReasons: string[] = [];
  let proofCompatible = true;
  let proofMode: "enabled" | "disabled" = "disabled";
  if (governsThisChain) {
    let gateConfig: ReturnType<typeof loadSolanaProofGate> | null = null;
    try {
      gateConfig = loadSolanaProofGate(env, (raw) => parseMoney(raw, assetByKey("solana.usdc")));
    } catch (err) {
      proofCompatible = false;
      proofReasons.push(`the configured proof gate could not be read: ${(err as Error).message}`);
    }
    if (gateConfig) {
      proofMode = gateConfig.enabled ? "enabled" : "disabled";
      if (!gateConfig.enabled) {
        /**
         * A disabled gate is NOT a refusal, and treating it as one was wrong.
         *
         * The gate is constructed only under `CONSUMER_SOLANA_PROOF_MODE=1`, and it NARROWS an
         * authority the rail's own `CONSUMER_SOLANA_EXECUTION_ENABLED` switch grants. With no gate
         * armed, that switch alone governs — which is exactly why production is refused today, and
         * refused by name (`EXECUTION_CONTROLS_DISABLED`) rather than by a gate that is not there.
         * Reporting an absent gate as a blocker would hide the real one.
         */
        proofReasons.push(
          "no proof gate is armed, so nothing narrows this chain further; the standing execution " +
            "controls alone govern it",
        );
      } else {
        if (gateConfig.intentId !== input.intentId) {
          proofCompatible = false;
          proofReasons.push("the armed proof gate names a different intent");
        }
        if (gateConfig.providerId !== input.provider) {
          proofCompatible = false;
          proofReasons.push("the armed proof gate names a different provider");
        }
        if (gateConfig.capability !== input.capability) {
          proofCompatible = false;
          proofReasons.push("the armed proof gate names a different capability");
        }
        if (gateConfig.maxAmount && maxAmount && gtMoney(maxAmount, gateConfig.maxAmount)) {
          proofCompatible = false;
          proofReasons.push("the requested ceiling exceeds the armed proof ceiling");
        }
        if (gateConfig.expiresAt !== null && now() >= gateConfig.expiresAt) {
          proofCompatible = false;
          proofReasons.push("the armed proof gate has expired");
        }
      }
    }
    if (!proofCompatible) {
      add("PROOF_GATE_INCOMPATIBLE", proofReasons.join("; "));
    }
  }

  const publicMaturity =
    provider && capability
      ? publicToolStateFor(provider, capability, standingSigner)
      : null;

  return {
    accepted: refusals.length === 0,
    intentId: input.intentId,
    provider: input.provider,
    capability: input.capability,
    action: input.capability,
    productionMaturity: {
      provider: provider?.maturity ?? null,
      capability: capability?.maturity ?? null,
      effective: effectiveMaturity,
      providerEnabled: provider?.enabled ?? false,
    },
    publicMaturity,
    expectedPolicyPath: {
      tenantId: input.tenantId,
      policyId,
      source: "policy-store",
      found: policyFound,
      status: policyStatus,
    },
    expectedSettlement: {
      chain: settlementChain,
      assetSymbol: settlementAsset?.symbol ?? null,
      treasuryRef,
      treasuryConfigured: treasuryRef !== null,
      treasuryEnabled,
      standingSigner,
    },
    maxAuthorisedAmount: maxAmount ? formatMoney(maxAmount) : null,
    executionFloor: { required: executionFloor, effective: effectiveMaturity, satisfied: floorSatisfied },
    executionControls: {
      packEnabled,
      executionEnabled,
      providerEnabled: providerFlagEnabled,
      chainEnabled,
      assetEnabled,
      flagRefusal,
    },
    proofGate: { governsThisChain, mode: proofMode, compatible: proofCompatible, reasons: proofReasons },
    fundingMode: input.fundingMode,
    idempotency: { keyAccepted: true, duplicate: duplicate !== null },
    deployment: d,
    refusals,
  };
}

/** Maturity ordering, re-exported so a caller can sort refusal severity without importing the registry. */
export { compareMaturity };
