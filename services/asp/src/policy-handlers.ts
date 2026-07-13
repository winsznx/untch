import {
  PolicyNotFoundError,
  PolicyValidationError,
  type PolicyRegistrationService,
  type PolicyService,
} from "@untch/policy-store";
import type { Address, Hex } from "viem";
import type { HandlerResult } from "./handlers";

/**
 * Framework-agnostic handlers for the operator-facing policy tools (§11). Each returns `{ status, body }`,
 * unit-testable with a fake chain + in-memory repo and no RPC/DB.
 *
 * PER-CALLER OWNERSHIP — `create_spend_policy` (see services/asp/README.md → "Operator signing"):
 * this tool NO LONGER signs on the caller's behalf. `PolicyRegistry.registerPolicy` is `msg.sender ==
 * owner` (direct, no relayer), so the only way a caller becomes the on-chain owner is to submit the tx
 * themselves. The tool therefore BUILDS the unsigned registerPolicy calldata and returns it; the caller's
 * OWN wallet signs + submits it; then `sync_policy_registration` records the row with the owner read from
 * the confirmed on-chain event. This is the same thing the dashboard already does (its connected wallet
 * signs directly) — the API path now matches it.
 *
 * `update/pause/resume_policy` still sign server-side with the interim operator wallet (unchanged this
 * build) — they can only mutate a policy that operator itself owns; bringing them to the same
 * unsigned-calldata parity is the same follow-up the dashboard's build{Update,Pause}Policy already models.
 */

function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

export interface PolicyToolDeps {
  /**
   * Per-caller create/sync surface (unsigned build + confirmation sync). Present whenever the durable
   * store is wired (DATABASE_URL). No signing key — the caller's own wallet signs. Null ⇒ create/sync 503.
   */
  readonly registration: PolicyRegistrationService | null;
  /** Signing surface for update/pause/resume. Null when OPERATOR_PRIVATE_KEY is unset — those tools 503. */
  readonly service: PolicyService | null;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^[0-9]+$/;
const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;

function requireService(deps: PolicyToolDeps): PolicyService | HandlerResult {
  if (!deps.service) {
    return {
      status: 503,
      body: errorEnvelope(
        "POLICY_SIGNER_NOT_CONFIGURED",
        "this instance has no operator signing key (OPERATOR_PRIVATE_KEY unset) — update/pause/resume are unavailable here",
      ),
    };
  }
  return deps.service;
}

function requireRegistration(deps: PolicyToolDeps): PolicyRegistrationService | HandlerResult {
  if (!deps.registration) {
    return {
      status: 503,
      body: errorEnvelope(
        "POLICY_STORE_NOT_CONFIGURED",
        "no durable policy store on this instance (DATABASE_URL unset) — create/sync need somewhere to record the confirmed owner",
      ),
    };
  }
  return deps.registration;
}

/** Turn a service error into the right §11 envelope. Chain reverts (NotPolicyOwner, PolicyNotActive,
 *  ExpiryInPast …) surface as ONCHAIN_ERROR with the revert reason — honest, never swallowed. */
function toErrorResult(err: unknown): HandlerResult {
  if (err instanceof PolicyValidationError) {
    return { status: 400, body: errorEnvelope(err.code, err.message) };
  }
  if (err instanceof PolicyNotFoundError) {
    return { status: 404, body: errorEnvelope("POLICY_NOT_FOUND", err.message) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 502, body: errorEnvelope("ONCHAIN_ERROR", message) };
}

// ─────────────────────────────────────────────────────────────────────────────
// create_spend_policy — BUILD the unsigned registerPolicy call for the caller to sign (BREAKING CHANGE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `create_spend_policy` (§11). BREAKING CHANGE to the calling convention: it NO LONGER signs or
 * broadcasts anything. It canonicalizes + hashes the submitted `rules` via @untch/canon and returns the
 * UNSIGNED registerPolicy calldata for the caller's OWN wallet to sign + submit. The caller becomes the
 * genuine on-chain owner (registerPolicy is `msg.sender == owner`), then calls `sync_policy_registration`
 * with the resulting txHash so the backend records the row from the confirmed on-chain event.
 *
 * The response carries `unsignedTx.calldata` (raw ABI-encoded, for any wallet) and the decoded args, plus
 * the canonical `policyHash` the caller can verify. No `owner` and no `tx` here — those exist only after
 * the caller submits and the confirmation is synced. Needs no signing key (the backend never signs).
 */
export async function handleCreateSpendPolicy(
  body: unknown,
  deps: PolicyToolDeps,
): Promise<HandlerResult> {
  const registration = requireRegistration(deps);
  if ("status" in registration) return registration;

  const b = (body ?? {}) as Record<string, unknown>;
  const agent = typeof b.agent === "string" ? b.agent : "";
  if (!ADDRESS_RE.test(agent)) {
    return {
      status: 400,
      body: errorEnvelope("AGENT_REQUIRED", "a governed `agent` 20-byte hex address is required"),
    };
  }
  if (!b.rules || typeof b.rules !== "object") {
    return {
      status: 400,
      body: errorEnvelope("RULES_REQUIRED", "a `rules` object (§8 policies.rules shape) is required"),
    };
  }

  try {
    const built = registration.buildCreate({ agent: agent as Address, rules: b.rules });
    const [agentArg, hashArg, expiryArg] = built.unsignedTx.args;
    return {
      status: 200,
      body: {
        policyHash: built.policyHash,
        registry: built.registry,
        chainId: built.chainId,
        agent: built.agentId,
        expiry: built.expiry,
        // JSON-safe: uint64 expiry as a decimal string inside args (a bigint would not serialize).
        unsignedTx: {
          to: built.unsignedTx.to,
          functionName: built.unsignedTx.functionName,
          chainId: built.unsignedTx.chainId,
          value: built.unsignedTx.value,
          calldata: built.unsignedTx.calldata,
          args: [agentArg, hashArg, expiryArg.toString()],
        },
        signer: "CALLER",
        callingConvention:
          "BREAKING: the backend does not sign. Sign + submit `unsignedTx` with YOUR OWN wallet " +
          "(you become the on-chain owner), then POST /sync_policy_registration { txHash, rules } to record it.",
      },
    };
  } catch (err) {
    return toErrorResult(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sync_policy_registration — record the durable row from the caller's confirmed registerPolicy tx
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sync_policy_registration`. The second half of the per-caller create flow: after the caller submits the
 * `create_spend_policy` calldata with their own wallet, they pass the resulting `txHash` (and the exact
 * `rules` they registered) here. The backend independently READS the confirmed `PolicyRegistered` event
 * and stores the row with `owner` = the real submitter from the event — never assumed, never caller-
 * supplied. The rules must hash to the anchored policyHash (`RULES_HASH_MISMATCH` otherwise), binding the
 * stored ruleset to what the chain committed. Idempotent: a re-sync (or a dashboard-created policy)
 * returns `alreadyStored: true` without duplicating.
 */
export async function handleSyncPolicyRegistration(
  body: unknown,
  deps: PolicyToolDeps,
): Promise<HandlerResult> {
  const registration = requireRegistration(deps);
  if ("status" in registration) return registration;

  const b = (body ?? {}) as Record<string, unknown>;
  const txHash = typeof b.txHash === "string" ? b.txHash.trim() : "";
  if (!TXHASH_RE.test(txHash)) {
    return {
      status: 400,
      body: errorEnvelope("TX_HASH_REQUIRED", "a `txHash` (0x-prefixed 32-byte hex) of the submitted registerPolicy tx is required"),
    };
  }
  if (!b.rules || typeof b.rules !== "object") {
    return {
      status: 400,
      body: errorEnvelope("RULES_REQUIRED", "the `rules` object that was registered is required (it must hash to the anchored policyHash)"),
    };
  }

  try {
    const res = await registration.syncRegistration({ txHash: txHash as Hex, rules: b.rules });
    return {
      status: 200,
      body: {
        policyId: res.policyId,
        owner: res.owner,
        agent: res.agentId,
        policyHash: res.policyHash,
        tx: res.txHash,
        blockNumber: res.blockNumber,
        version: res.version,
        expiry: res.expiry,
        alreadyStored: res.alreadyStored,
      },
    };
  } catch (err) {
    return toErrorResult(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// update_policy — revise a policy's ruleset (new hash + version) on-chain + in Postgres
// ─────────────────────────────────────────────────────────────────────────────

/** `update_policy` (§11, 0.10). Re-hashes the new `rules`, calls PolicyRegistry.updatePolicy (version
 *  bump), and syncs Postgres. 404 if the policy is unknown; ONCHAIN_ERROR if the chain rejects (e.g.
 *  NotPolicyOwner when the operator does not own it). */
export async function handleUpdatePolicy(
  body: unknown,
  deps: PolicyToolDeps,
): Promise<HandlerResult> {
  const service = requireService(deps);
  if ("status" in service) return service;

  const b = (body ?? {}) as Record<string, unknown>;
  const policyId = typeof b.policyId === "string" ? b.policyId.trim() : "";
  if (!UINT_RE.test(policyId)) {
    return {
      status: 400,
      body: errorEnvelope("POLICY_ID_REQUIRED", "a `policyId` (uint256 decimal string) is required"),
    };
  }
  if (!b.rules || typeof b.rules !== "object") {
    return {
      status: 400,
      body: errorEnvelope("RULES_REQUIRED", "a `rules` object (§8 policies.rules shape) is required"),
    };
  }

  try {
    const res = await service.updatePolicy({ policyId, rules: b.rules });
    return {
      status: 200,
      body: {
        policyId: res.policyId,
        policyHash: res.policyHash,
        tx: res.txHash,
        blockNumber: res.blockNumber,
        version: res.version,
        expiry: res.expiry,
      },
    };
  } catch (err) {
    return toErrorResult(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// pause_policy / resume_policy — flip on-chain status + sync Postgres
// ─────────────────────────────────────────────────────────────────────────────

function readPolicyIdBody(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = typeof b.policyId === "string" ? b.policyId.trim() : "";
  return UINT_RE.test(raw) ? raw : null;
}

/** `pause_policy` (§11). Calls PolicyRegistry.pausePolicy and marks the stored row PAUSED. A double
 *  pause reverts on-chain (PolicyNotActive) → ONCHAIN_ERROR, surfaced honestly. */
export async function handlePausePolicy(
  body: unknown,
  deps: PolicyToolDeps,
): Promise<HandlerResult> {
  return mutateStatus(body, deps, "pause");
}

/** `resume_policy` — the inverse of pause; PAUSED → ACTIVE on-chain + in Postgres. */
export async function handleResumePolicy(
  body: unknown,
  deps: PolicyToolDeps,
): Promise<HandlerResult> {
  return mutateStatus(body, deps, "resume");
}

async function mutateStatus(
  body: unknown,
  deps: PolicyToolDeps,
  op: "pause" | "resume",
): Promise<HandlerResult> {
  const service = requireService(deps);
  if ("status" in service) return service;

  const policyId = readPolicyIdBody(body);
  if (!policyId) {
    return {
      status: 400,
      body: errorEnvelope("POLICY_ID_REQUIRED", "a `policyId` (uint256 decimal string) is required"),
    };
  }

  try {
    const res =
      op === "pause"
        ? await service.pausePolicy(policyId)
        : await service.resumePolicy(policyId);
    return {
      status: 200,
      body: { policyId: res.policyId, status: res.status, tx: res.txHash, blockNumber: res.blockNumber },
    };
  } catch (err) {
    return toErrorResult(err);
  }
}
