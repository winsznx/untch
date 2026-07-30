/**
 * Every decision the remote proof controller makes, as pure functions over data.
 *
 * WHY THE DECISIONS LIVE APART FROM THE RUNNER
 *
 * The controller's value is entirely in what it REFUSES. It refuses to run with a database credential
 * in its environment, it refuses a deployment that cannot prove its commit, it refuses to create an
 * intent when preflight said no. Each of those is worth a test, and none of them is worth a socket to
 * test. So the refusals are here, returning verdicts, and `runner.ts` does nothing but sequence them
 * and print.
 *
 * WHAT THIS MODULE MAY IMPORT, AND WHY THE LIST IS SHORT
 *
 * `node:crypto`, the canonical identifier helpers, and the canonical tenant formula. That is all. Both
 * of those are leaf modules with no transitive dependency on a store, a rail client, a signer or an
 * adapter — verified by `scripts/test/proof-controller-imports.test.ts`, which walks the real import
 * graph rather than trusting this comment.
 *
 * The restriction is not stylistic. A controller that had merely CHOSEN not to open a database is a
 * controller one edit away from opening one, and the evidence a production proof produces is only worth
 * anything if the thing producing it could not have taken a shortcut. `@untch/consumer-core`'s barrel
 * export pulls in `PgConsumerStore`, so importing `isIntentId` from the barrel would put `pg` in this
 * process. The deep import is the point.
 */

import { createHash } from "node:crypto";
import { isIntentId, stableStringify } from "../../packages/consumer-core/src/ids";
import {
  isOnchainPolicyId,
  policyIdForTenant,
  tenantForPolicy,
} from "../../services/asp/src/consumer/tenant";

export { isIntentId, tenantForPolicy };

/** A refusal the controller makes about itself or about what production told it. */
export class ControllerRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: readonly string[] = [],
  ) {
    super(message);
    this.name = "ControllerRefusal";
  }
}

// ── the environment ──────────────────────────────────────────────────────────

/**
 * The only variables the controller reads. Anything else it needs comes from an argument.
 *
 * An allowlist rather than a deny-list, because the interesting failure is a variable NOBODY thought
 * about. A deny-list protects against the credentials someone remembered; an allowlist means a
 * credential added to `.env` next year cannot become something this process silently picks up.
 */
export const ALLOWED_ENV = [
  "UNTCH_ASP_URL",
  "INTERNAL_OPS_TOKEN",
  "UNTCH_EXPECTED_SERVING_COMMIT",
] as const;

/**
 * Variables whose mere PRESENCE is a refusal.
 *
 * Not because the controller would use them — it reads only the allowlist above — but because their
 * presence means this process was started with an environment that could execute locally. The whole
 * claim being made is "the local process could not have done this itself", and a process holding
 * production's database URL cannot make that claim regardless of which lines of code it ran.
 *
 * `DATABASE_URL` heads the list for the specific reason that PASS 1's `--deployed-worker-only` held one:
 * it skipped the local `executeIntent` call and kept every other production capability, so the flag
 * described an intention rather than a boundary.
 */
export const FORBIDDEN_LOCAL_ENV = [
  "DATABASE_URL",
  "CONSUMER_TREASURY_SOLANA_SECRET_KEY",
  "CONSUMER_TREASURY_BASE_PRIVATE_KEY",
  "CONSUMER_SOLANA_PROOF_SECRET_KEY",
  "CONSUMER_SOLANA_RESERVE_SECRET_KEY",
  "CONSUMER_SIWX_PRIVATE_KEY",
  "CONSUMER_POLICY_OWNER_PRIVATE_KEY",
  "OPERATOR_PRIVATE_KEY",
  "ORACLE_PRIVATE_KEY",
  "ADMIN_PRIVATE_KEY",
  "INTENT_WRITER_PRIVATE_KEY",
  "CONSUMER_TEST_FUNDER_PRIVATE_KEY",
  "REDIS_URL",
] as const;

/**
 * Refuse before the first network request if this process can do anything locally.
 *
 * Deliberately ordered first in the runner, ahead of even the plan print. A refusal that happened after
 * a remote mutation would be a refusal that came too late to mean anything.
 */
export function assertKeylessEnvironment(env: NodeJS.ProcessEnv): void {
  const present = FORBIDDEN_LOCAL_ENV.filter((name) => (env[name]?.trim() ?? "") !== "");
  if (present.length === 0) return;
  throw new ControllerRefusal(
    "CONTROLLER_ENVIRONMENT_NOT_KEYLESS",
    "this process holds credentials that would let it act on production directly, so nothing it " +
      "reported could be evidence about the deployed service",
    [
      ...present.map((name) => `${name} is set`),
      "",
      "Run the controller with these scrubbed. They are not read by this command, and their presence " +
        "alone is what is being refused:",
      `  env -u ${present.join(" -u ")} pnpm consumer:smoke:live ...`,
    ],
  );
}

export interface ControllerEnv {
  readonly aspUrl: string;
  readonly opsToken: string;
  readonly expectedServingCommit: string;
}

/**
 * Read the three variables, and say which one is missing rather than which one is wrong.
 *
 * `allowLoopbackHttp` exists for the two-process integration test and for nothing else. A loopback test
 * server cannot serve https without a certificate that has no business being generated in a test suite,
 * so the SCHEME requirement is relaxed — and only for `127.0.0.1` and `localhost`, so it cannot be used
 * to point the controller at a plaintext host on a network. Every other refusal still applies unchanged.
 *
 * It is a function parameter fed by an explicit `--allow-loopback-http` flag rather than an environment
 * variable on purpose. An environment variable is the kind of thing that ends up set on a deployment and
 * forgotten; a flag has to be typed by whoever ran the command.
 */
export function readControllerEnv(
  env: NodeJS.ProcessEnv,
  opts: { readonly allowLoopbackHttp?: boolean } = {},
): ControllerEnv {
  const aspUrl = env.UNTCH_ASP_URL?.trim() ?? "";
  const opsToken = env.INTERNAL_OPS_TOKEN?.trim() ?? "";
  const expectedServingCommit = env.UNTCH_EXPECTED_SERVING_COMMIT?.trim() ?? "";

  if (aspUrl === "") {
    throw new ControllerRefusal(
      "ASP_URL_MISSING",
      "UNTCH_ASP_URL is not set, so there is no deployed service to control",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(aspUrl);
  } catch {
    throw new ControllerRefusal("ASP_URL_MALFORMED", "UNTCH_ASP_URL is not a URL");
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(opts.allowLoopbackHttp === true && isLoopback)) {
    throw new ControllerRefusal(
      "ASP_URL_NOT_HTTPS",
      "UNTCH_ASP_URL must be https. The operator token travels on this connection.",
      opts.allowLoopbackHttp === true && !isLoopback
        ? [`--allow-loopback-http was passed, but ${parsed.hostname} is not a loopback host`]
        : [],
    );
  }
  if (opsToken === "") {
    throw new ControllerRefusal(
      "OPS_TOKEN_MISSING",
      "INTERNAL_OPS_TOKEN is not set, so the controller cannot authenticate to the operator routes",
    );
  }
  if (expectedServingCommit === "") {
    throw new ControllerRefusal(
      "EXPECTED_COMMIT_MISSING",
      "UNTCH_EXPECTED_SERVING_COMMIT is not set. The controller will not talk to a deployment whose " +
        "code it has not been told to expect: a build that failed leaves an older container serving, " +
        "and that container is what would answer.",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(expectedServingCommit)) {
    throw new ControllerRefusal(
      "EXPECTED_COMMIT_MALFORMED",
      "UNTCH_EXPECTED_SERVING_COMMIT must be a full 40-character commit SHA. A short SHA would make a " +
        "prefix collision indistinguishable from a match.",
    );
  }

  return { aspUrl: aspUrl.replace(/\/+$/, ""), opsToken, expectedServingCommit };
}

// ── the execution plan ───────────────────────────────────────────────────────

/**
 * What this run will and will not do, printed before it does any of it.
 *
 * Written as data so the runner cannot print a plan that diverges from the code, and so a test can
 * assert the disabled lines are present. Every "disabled" line below is enforced by
 * `assertKeylessEnvironment` and by the import graph, not by this text.
 */
export const EXECUTION_PLAN: readonly (readonly [string, string])[] = [
  ["MODE", "DEPLOYED_WORKER_ONLY"],
  ["Controller", "local"],
  ["Intent creation", "production ASP"],
  ["Intent store", "production database through ASP"],
  ["Policy engine", "production ASP"],
  ["Reservation", "production ASP"],
  ["Queue", "production database"],
  ["Worker", "Railway untch-asp"],
  ["Provider execution", "Railway untch-asp"],
  ["Signer", "Railway temporary proof signer"],
  ["Ledger", "production database"],
  ["Receipt", "production receipt system"],
  ["Local database access", "disabled"],
  ["Local provider execution", "disabled"],
  ["Local signer", "disabled"],
  ["Local worker", "disabled"],
];

// ── the request ──────────────────────────────────────────────────────────────

export interface ControllerRequest {
  readonly intentId: string;
  readonly policyId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly provider: string;
  readonly capability: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly providerRef: string;
  readonly maxProviderAmount: string;
  readonly expectedSettlementChain: string;
  readonly expectedSettlementAsset: string;
  readonly fundingMode: "operator-funded" | "externally-funded";
  readonly idempotencyKey: string;
  readonly expiresAt: string;
}

/**
 * Derive the tenant from the policy id, and refuse a caller who supplies a different one.
 *
 * The tenant IS the policy partition, and production has one convention for saying so. An operator may
 * pass `--tenant-id` — some runbooks record it, and a mismatch between what they recorded and what the
 * policy implies is a mistake worth surfacing — but the DERIVED value always wins, and a supplied one
 * that disagrees is a refusal rather than an override. Accepting both as independent inputs would
 * reintroduce exactly the second binding this convention exists to avoid.
 */
export function deriveTenant(policyId: string, supplied: string | null): string {
  if (!isOnchainPolicyId(policyId)) {
    throw new ControllerRefusal(
      "POLICY_ID_MALFORMED",
      `--policy-id must be an on-chain PolicyRegistry id (a uint256 decimal string), got ${JSON.stringify(policyId)}`,
    );
  }
  const derived = tenantForPolicy(policyId);
  if (supplied === null) return derived;
  if (supplied !== derived) {
    throw new ControllerRefusal(
      "TENANT_MISMATCH",
      `--tenant-id ${JSON.stringify(supplied)} does not match the tenant policy ${policyId} implies ` +
        `(${derived}). The tenant is derived from the policy, never declared beside it.`,
    );
  }
  const roundTrip = policyIdForTenant(supplied);
  if (roundTrip !== policyId) {
    throw new ControllerRefusal(
      "TENANT_NOT_CANONICAL",
      `${JSON.stringify(supplied)} does not round-trip to policy ${policyId}`,
    );
  }
  return derived;
}

/**
 * One idempotency key, bound to everything that makes this request the request it is.
 *
 * A key bound to less than the whole request is a key that would let a DIFFERENT request replay as this
 * one. A key bound to more — a timestamp, a run id — would make a legitimate retry look like a new
 * authorisation, which on a payment path is the more expensive mistake of the two.
 */
export function buildIdempotencyKey(parts: {
  readonly intentId: string;
  readonly policyId: string;
  readonly provider: string;
  readonly capability: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly maxProviderAmount: string;
  readonly expiresAt: string;
}): string {
  const digest = createHash("sha256").update(stableStringify(parts)).digest("hex");
  return `proof-${parts.intentId}-${digest.slice(0, 32)}`;
}

export function requestHash(request: Readonly<Record<string, unknown>>): string {
  return `0x${createHash("sha256").update(stableStringify(request)).digest("hex")}`;
}

// ── deployment identity ──────────────────────────────────────────────────────

export interface DeploymentInfoResponse {
  readonly phase?: string;
  readonly commit?: string | null;
  readonly attested?: boolean;
  readonly railwayDeploymentId?: string | null;
  readonly migrationVersion?: string | null;
  readonly settlementRails?: readonly string[];
  readonly proofGate?: { readonly code?: string; readonly schema?: string; readonly proofMode?: string };
  readonly solana?: {
    readonly signer?: string;
    readonly execution?: string;
    readonly rpcHost?: string | null;
    readonly rpcMode?: string;
  };
}

export interface DeploymentExpectation {
  readonly expectedServingCommit: string;
  readonly expectedMigration: string;
  readonly expectedRpcHost: string;
  readonly requireBaseRail: boolean;
}

export const DEFAULT_DEPLOYMENT_EXPECTATION = {
  expectedMigration: "012_settlement_account_registration.sql",
  expectedRpcHost: "solana-mainnet.g.alchemy.com",
  requireBaseRail: true,
} as const;

/**
 * Refuse anything but an exact match, and collect every mismatch before refusing.
 *
 * One mismatch at a time would mean an operator arming a bounded window discovers the second problem
 * only after fixing the first, and each discovery costs a deploy. Every check that CAN run does.
 *
 * There is no warning path. The incident this whole verification exists to prevent was a deployment
 * that granted spending authority on the belief that new code was live, and the shape of that failure
 * is always "a mismatch was visible and treated as tolerable".
 */
export function assertDeploymentIdentity(
  info: DeploymentInfoResponse,
  expect: DeploymentExpectation,
  healthzStatus: number,
): void {
  const problems: string[] = [];

  if (healthzStatus !== 200) problems.push(`/healthz answered ${healthzStatus}, not 200`);
  if (info.phase !== "READY") problems.push(`phase is ${info.phase ?? "(absent)"}, not READY`);
  if (info.attested !== true) {
    problems.push("the deployment carries no build attestation, so its serving commit cannot be proven");
  }
  if (typeof info.commit !== "string" || info.commit.length !== 40) {
    problems.push("the deployment reported no full serving commit");
  } else if (info.commit !== expect.expectedServingCommit) {
    problems.push(
      `serving commit ${info.commit.slice(0, 7)} is not the expected ${expect.expectedServingCommit.slice(0, 7)}`,
    );
  }
  if (typeof info.railwayDeploymentId !== "string" || info.railwayDeploymentId.trim() === "") {
    problems.push("the deployment reported no serving deployment id");
  }
  if (info.migrationVersion !== expect.expectedMigration) {
    problems.push(`migration is ${info.migrationVersion ?? "(absent)"}, not ${expect.expectedMigration}`);
  }
  if (info.proofGate?.code !== "present") problems.push("the proof-gate code is not present in this build");
  if (info.proofGate?.schema !== "ready") problems.push("the proof-gate schema is not ready");
  if (expect.requireBaseRail && !(info.settlementRails ?? []).includes("eip155:8453")) {
    problems.push(
      "the Base settlement rail is not available. A Solana proof must not cost Base its rail, so its " +
        "absence is treated as a change nobody asked for.",
    );
  }
  if (info.solana?.rpcHost !== expect.expectedRpcHost) {
    problems.push(`the Solana RPC host is ${info.solana?.rpcHost ?? "(absent)"}, not ${expect.expectedRpcHost}`);
  }
  if (info.solana?.signer !== "present" && info.solana?.signer !== "absent") {
    problems.push("the deployment did not report a signer state");
  }
  if (info.solana?.execution !== "enabled" && info.solana?.execution !== "disabled") {
    problems.push("the deployment did not report an execution state");
  }
  if (info.proofGate?.proofMode !== "enabled" && info.proofGate?.proofMode !== "disabled") {
    problems.push("the deployment did not report a proof-mode state");
  }

  if (problems.length > 0) {
    throw new ControllerRefusal(
      "DEPLOYMENT_IDENTITY_MISMATCH",
      "the deployment answering this controller is not the deployment it was told to expect",
      problems,
    );
  }
}

// ── readiness ────────────────────────────────────────────────────────────────

export interface PlanResponse {
  readonly accepted?: boolean;
  readonly readinessClass?: string;
  readonly refusals?: readonly { readonly code: string; readonly message: string }[];
  readonly expectedPolicyPath?: { readonly policyId?: string | null; readonly found?: boolean; readonly status?: string | null };
  readonly expectedSettlement?: Record<string, unknown>;
  readonly productionMaturity?: Record<string, unknown>;
  readonly publicMaturity?: string | null;
  readonly maxAuthorisedAmount?: string | null;
  readonly proofGate?: Record<string, unknown>;
  readonly idempotency?: { readonly duplicate?: boolean };
  readonly deployment?: Record<string, unknown>;
}

/**
 * The structural facts that must hold before an operator throws a single switch.
 *
 * Checked against the plan's own fields rather than inferred from the absence of refusal codes.
 * "No refusal mentioned the policy" and "the policy exists" are different statements, and only the
 * second is worth acting on.
 */
export function assertReadyToArm(
  plan: PlanResponse,
  expect: {
    readonly policyId: string;
    readonly provider: string;
    readonly capability: string;
    readonly publicMaturity: string;
  },
): void {
  const problems: string[] = [];

  if (plan.readinessClass !== "READY_TO_ARM") {
    problems.push(
      `readinessClass is ${plan.readinessClass ?? "(absent)"}, not READY_TO_ARM` +
        (plan.readinessClass === "STRUCTURAL_BLOCKED"
          ? " — something is wrong that arming will not fix"
          : ""),
    );
  }
  if (plan.expectedPolicyPath?.policyId !== expect.policyId) {
    problems.push(`the plan resolved policy ${plan.expectedPolicyPath?.policyId ?? "(none)"}, not ${expect.policyId}`);
  }
  if (plan.expectedPolicyPath?.found !== true) problems.push("the production policy store does not hold this policy");
  if (plan.expectedPolicyPath?.status !== "ACTIVE") {
    problems.push(`the policy is ${plan.expectedPolicyPath?.status ?? "(unknown)"}, not ACTIVE`);
  }

  const maturity = plan.productionMaturity ?? {};
  if (maturity.provider !== "verified") problems.push(`provider maturity is ${String(maturity.provider)}, not verified`);
  if (maturity.capability !== "verified") {
    problems.push(`capability maturity is ${String(maturity.capability)}, not verified`);
  }
  if (plan.publicMaturity !== expect.publicMaturity) {
    problems.push(`public maturity is ${plan.publicMaturity ?? "(absent)"}, not ${expect.publicMaturity}`);
  }

  const settlement = plan.expectedSettlement ?? {};
  if (settlement.accountRegistered !== true) problems.push("no settlement account is registered for this rail");
  if (settlement.accountFunded !== true) problems.push("the registered settlement account is not funded for this ceiling");
  if (plan.idempotency?.duplicate === true) problems.push("this idempotency key already names an intent");

  if (problems.length > 0) {
    throw new ControllerRefusal(
      "NOT_READY_TO_ARM",
      "production is not in a state an operator should arm",
      [...problems, ...(plan.refusals ?? []).map((r) => `refusal ${r.code}: ${r.message}`)],
    );
  }
}

/**
 * The readiness class a run was told to expect, and the refusal when production disagrees.
 *
 * `--preflight-only` used to assert READY_TO_ARM unconditionally, which made it useless for the second
 * half of an arming sequence: once production was legitimately ARMED_AND_EXECUTABLE the command exited
 * non-zero, and the honest posture read as a failure.
 *
 * The fix is NOT to accept any class. That would turn the one command an operator uses to check "is
 * production where I think it is" into a command that always says yes. The expectation is stated instead,
 * so a mismatch in either direction is a refusal: expecting READY_TO_ARM against an already-armed
 * deployment is just as much a surprise as the reverse, and an operator who is surprised should stop.
 */
export function assertExpectedReadiness(plan: PlanResponse, expected: string): void {
  if (!(READINESS_EXPECTATIONS as readonly string[]).includes(expected)) {
    throw new ControllerRefusal(
      "READINESS_EXPECTATION_UNKNOWN",
      `--expect-readiness must be one of ${READINESS_EXPECTATIONS.join(", ")}, got ${JSON.stringify(expected)}`,
    );
  }
  if (plan.readinessClass !== expected) {
    throw new ControllerRefusal(
      "READINESS_MISMATCH",
      `production is ${plan.readinessClass ?? "(absent)"}, and this run expected ${expected}`,
      [
        expected === "READY_TO_ARM" && plan.readinessClass === "ARMED_AND_EXECUTABLE"
          ? "production is already armed. If that is intended, expect ARMED_AND_EXECUTABLE."
          : "",
        ...(plan.refusals ?? []).map((r) => `refusal ${r.code}: ${r.message}`),
      ].filter((line) => line !== ""),
    );
  }
  // ARMED_AND_EXECUTABLE additionally requires the two facts that make it safe to create against.
  if (expected === "ARMED_AND_EXECUTABLE") assertArmedAndExecutable(plan);
}

export const READINESS_EXPECTATIONS = ["READY_TO_ARM", "ARMED_AND_EXECUTABLE"] as const;

export function assertArmedAndExecutable(plan: PlanResponse): void {
  if (plan.accepted === true && plan.readinessClass === "ARMED_AND_EXECUTABLE") return;
  throw new ControllerRefusal(
    "NOT_ARMED_AND_EXECUTABLE",
    "preflight did not report an armed, executable plan, so no intent will be created",
    [
      `accepted: ${String(plan.accepted)}`,
      `readinessClass: ${plan.readinessClass ?? "(absent)"}`,
      ...(plan.refusals ?? []).map((r) => `refusal ${r.code}: ${r.message}`),
    ],
  );
}
