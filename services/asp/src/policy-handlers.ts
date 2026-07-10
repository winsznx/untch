import {
  PolicyNotFoundError,
  PolicyValidationError,
  type PolicyService,
} from "@untch/policy-store";
import type { Address } from "viem";
import type { HandlerResult } from "./handlers";

/**
 * Framework-agnostic handlers for the operator-facing policy tools (§11 create/update/pause_policy).
 * Each returns `{ status, body }`, unit-testable with a fake chain + in-memory repo and no RPC/DB.
 *
 * TRUST-MODEL NOTE (see services/asp/README.md → "Operator signing"): these tools sign the real
 * on-chain registerPolicy/updatePolicy/pausePolicy with the OPERATOR wallet. In this interim build
 * that is the demo/burner wallet 0x98F43e… held server-side — a TEMPORARY stand-in for the operator's
 * OWN dashboard-connected wallet (§15). The target flow is: the backend returns unsigned calldata, the
 * operator's connected wallet signs + submits, and we sync Postgres from the observed confirmation.
 * The demo shortcut is NOT the intended architecture; it is labeled everywhere it appears.
 */

function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

export interface PolicyToolDeps {
  /** Null when OPERATOR_PRIVATE_KEY is unset — the instance can read policies but not sign mutations. */
  readonly service: PolicyService | null;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^[0-9]+$/;

function requireService(deps: PolicyToolDeps): PolicyService | HandlerResult {
  if (!deps.service) {
    return {
      status: 503,
      body: errorEnvelope(
        "POLICY_SIGNER_NOT_CONFIGURED",
        "this instance has no operator signing key (OPERATOR_PRIVATE_KEY unset) — policy mutations are unavailable here",
      ),
    };
  }
  return deps.service;
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
// create_spend_policy — register a new policy on-chain + store it durably
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `create_spend_policy` (§11, 0.50). Canonicalizes + hashes the submitted `rules` via @untch/canon,
 * derives the policyId from the LIVE on-chain owner nonce, calls the real PolicyRegistry.registerPolicy
 * with the operator wallet, stores the confirmed result in Postgres, and returns {policyId, hash, tx}.
 */
export async function handleCreateSpendPolicy(
  body: unknown,
  deps: PolicyToolDeps,
): Promise<HandlerResult> {
  const service = requireService(deps);
  if ("status" in service) return service;

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
    const res = await service.createPolicy({ agent: agent as Address, rules: b.rules });
    return {
      status: 200,
      body: {
        policyId: res.policyId,
        policyHash: res.policyHash,
        tx: res.txHash,
        blockNumber: res.blockNumber,
        version: res.version,
        agent: res.agentId,
        owner: res.owner,
        expiry: res.expiry,
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
