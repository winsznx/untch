/**
 * The objects an Untch-owned service is made of, and the states each one may be in.
 *
 * THE SEPARATION THIS FILE EXISTS TO HOLD
 *
 * `WorkIntent` says what should be done. `SpendIntent` says what money may move. They are different
 * objects with different owners and they must never be the same row, because the model gets to
 * propose the first and must never be able to touch the second. A plan that could enlarge its own
 * budget is a plan that will, on the day a prompt is worded slightly differently.
 *
 * So a `WorkPlan` may create CHILD spend intents — for a paid API, a dataset, compute — and every one
 * of them is bounded by the parent order's ceiling, judged by the same policy engine as any other
 * payment, and attributed back to the node that asked for it. The runtime enforces the ceiling; it is
 * not a number in a prompt.
 *
 * WHY THE STATES ARE LISTED RATHER THAN INFERRED
 *
 * `FAILED_BEFORE_COST` and `FAILED_AFTER_COST` are two states because they are two different
 * conversations with a customer. `PARTIALLY_DELIVERED` exists because a run that produced three of
 * four artifacts has not failed and has not delivered, and calling it either is a lie in one
 * direction or the other.
 */

import type { Hex } from "viem";

/** Where an order is in its life. Ordered roughly as it advances; not every order visits every state. */
export type WorkState =
  | "DRAFT"
  | "QUOTED"
  | "AWAITING_PAYMENT"
  | "FUNDED"
  | "PLANNING"
  | "AWAITING_CHECKPOINT"
  | "RUNNING"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED"
  | "VERIFIED"
  | "FAILED_BEFORE_COST"
  | "FAILED_AFTER_COST"
  | "CANCELLED"
  | "EXPIRED";

export const TERMINAL_WORK_STATES: readonly WorkState[] = Object.freeze([
  "VERIFIED",
  "FAILED_BEFORE_COST",
  "FAILED_AFTER_COST",
  "CANCELLED",
  "EXPIRED",
]);

/** Where one node of a plan is. `WAITING_FOR_USER` is distinct from `BLOCKED`: one of them is our fault. */
export type NodeState =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "BLOCKED"
  | "WAITING_FOR_USER"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED";

export type CheckpointState = "PROPOSED" | "APPROVED" | "EDITED" | "REJECTED" | "EXPIRED" | "SUPERSEDED";

export type RunState = "RUNNING" | "SUCCEEDED" | "FAILED" | "ABANDONED";

/**
 * Why a run failed, in categories that decide what happens to the money.
 *
 * `EXTERNAL_COST_EXCEEDED` is separated from `PROVIDER_FAILED` because the first is our budgeting
 * being wrong and the second is somebody else being down, and a refund policy that cannot tell them
 * apart will either overpay or argue with customers.
 */
export type FailureClass =
  | "INPUT_INVALID"
  | "EVIDENCE_UNAVAILABLE"
  | "EXTERNAL_COST_EXCEEDED"
  | "PROVIDER_FAILED"
  | "CHECKPOINT_REJECTED"
  | "CHECKPOINT_EXPIRED"
  | "DEADLINE_PASSED"
  | "INTERNAL_ERROR";

export interface ServiceOrder {
  readonly orderId: string;
  readonly accountId: string;
  /** The marketplace job this order answers, when it came from one. */
  readonly marketplaceRef: string | null;
  readonly serviceId: string;
  readonly serviceVersion: string;
  /** Ceiling, in base units of `currency`. Integer string — never a float. */
  readonly maxPriceBaseUnits: string;
  /** What was actually charged, in base units. Null until settlement. */
  readonly actualPriceBaseUnits: string | null;
  readonly currency: string;
  readonly state: WorkState;
  readonly deadline: string;
  readonly policyId: string | null;
  readonly caseId: string | null;
  readonly intentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What the customer wants, normalised, hashed, and never rewritten.
 *
 * `canonicalHash` is what a checkpoint approval binds to. Rewriting the brief after approval would
 * change the hash, which is how "you approved something else" is detected rather than argued about.
 */
export interface WorkIntent {
  readonly workIntentId: string;
  readonly orderId: string;
  readonly objective: string;
  readonly normalisedBrief: Record<string, unknown>;
  readonly constraints: Record<string, unknown>;
  readonly acceptanceCriteria: Record<string, unknown>;
  /** Most this work may spend on external evidence, in base units of the order's currency. */
  readonly maxExternalCostBaseUnits: string;
  readonly deadline: string;
  readonly canonicalHash: Hex;
  readonly createdAt: string;
}

export interface WorkPlan {
  readonly workPlanId: string;
  readonly workIntentId: string;
  readonly version: number;
  readonly planHash: Hex;
  readonly state: "PROPOSED" | "CONFIRMED" | "SUPERSEDED" | "ABANDONED";
  /** `system` for a deterministic plan; a model id when one proposed it. Recorded, never inferred. */
  readonly createdBy: string;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
}

export type NodeType =
  | "RESOLVE"
  | "FETCH_EVIDENCE"
  | "EXTRACT"
  | "COMPARE"
  | "DRAFT"
  | "RENDER"
  | "PUBLISH"
  | "MANIFEST";

export interface WorkNode {
  readonly nodeId: string;
  readonly planId: string;
  readonly type: NodeType;
  /** Node ids this one waits for. The DAG is these edges and nothing else. */
  readonly dependsOn: readonly string[];
  readonly inputHash: Hex;
  readonly outputHash: Hex | null;
  readonly workerVersion: string;
  readonly skillVersion: string | null;
  /** The model that produced this node's output, when one did. Null means no model was involved. */
  readonly modelVersion: string | null;
  readonly maxCostBaseUnits: string;
  readonly actualCostBaseUnits: string;
  readonly maxAttempts: number;
  readonly attempts: number;
  /** Stable across retries, so a retried node cannot double-charge a child spend. */
  readonly idempotencyKey: string;
  readonly state: NodeState;
  readonly failure: FailureClass | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/**
 * A gate the run stops at, with the exact thing being agreed to.
 *
 * `proposedDataHash` is what an approval binds to, and `version` is what makes approving v1 not an
 * approval of v2. Both are load-bearing: a checkpoint that recorded only "approved: true" would let
 * an edited plan inherit an agreement made about a different plan.
 */
export interface WorkCheckpoint {
  readonly checkpointId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly type: string;
  readonly prompt: string;
  readonly proposedData: Record<string, unknown>;
  readonly proposedDataHash: Hex;
  readonly approvedData: Record<string, unknown> | null;
  readonly decision: "APPROVE" | "EDIT" | "REJECT" | null;
  readonly decidedBy: string | null;
  readonly nonce: string;
  readonly state: CheckpointState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

export interface WorkRun {
  readonly runId: string;
  readonly planId: string;
  readonly attempt: number;
  readonly state: RunState;
  readonly failure: FailureClass | null;
  readonly costBaseUnits: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/**
 * One factual claim, with what backs it.
 *
 * `sourceType` distinguishes what the vendor says about itself from what a third party says, and
 * `confidence` is allowed to be low. Neither field may be dropped when the claim is rendered — an
 * artifact that removes the uncertainty its evidence carried is a stronger document than the work
 * supports, and it will be believed exactly as far as it is confident.
 */
export interface EvidenceClaim {
  readonly claimId: string;
  readonly orderId: string;
  readonly nodeId: string | null;
  readonly statement: string;
  readonly sourceRef: string | null;
  readonly sourceType:
    | "VENDOR_PUBLISHED"
    | "THIRD_PARTY"
    | "CUSTOMER_SUPPLIED"
    | "DERIVED"
    | "UNVERIFIED";
  readonly observedAt: string;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly extractHash: Hex | null;
  readonly artifactRefs: readonly string[];
  /** When this claim should be re-checked. Null when it is not time-sensitive. */
  readonly freshUntil: string | null;
}

/** One promised deliverable, and whether it actually exists. */
export interface ManifestEntry {
  readonly name: string;
  readonly mimeType: string;
  readonly required: boolean;
  readonly artifactId: string | null;
  readonly versionId: string | null;
  readonly contentHash: Hex | null;
  readonly sizeBytes: number | null;
  readonly present: boolean;
}

/**
 * What was promised against what was produced.
 *
 * `acceptance` is computed from `entries`, never asserted. A manifest that said PASS while a required
 * entry had `present: false` would be the exact failure the artifact contract exists to prevent, so
 * the only way to build one is through `evaluateManifest`.
 */
export interface DeliveryManifest {
  readonly manifestId: string;
  readonly orderId: string;
  readonly serviceId: string;
  readonly serviceVersion: string;
  readonly entries: readonly ManifestEntry[];
  readonly acceptance: "PASS" | "PARTIAL" | "FAIL";
  readonly generatedAt: string;
  readonly manifestHash: Hex;
}

/**
 * Grade a manifest from its entries alone.
 *
 * PASS — every required entry is present.
 * PARTIAL — at least one required entry is present and at least one is missing.
 * FAIL — no required entry is present, or the contract promised nothing (which is a definition bug,
 *        and reporting PASS for it would hide one).
 */
export function evaluateManifest(entries: readonly ManifestEntry[]): "PASS" | "PARTIAL" | "FAIL" {
  const required = entries.filter((e) => e.required);
  if (required.length === 0) return "FAIL";
  const present = required.filter((e) => e.present).length;
  if (present === required.length) return "PASS";
  return present === 0 ? "FAIL" : "PARTIAL";
}
