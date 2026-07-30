/**
 * The remote proof controller. It drives one production Consumer Intent over authenticated HTTP and
 * holds nothing that could produce that intent by itself.
 *
 *   pnpm consumer:smoke:live --deployed-worker-only --provider purch \
 *     --operator-funded --policy-id <id> --intent-id <ci_…> [--preflight-only]
 *
 * WHAT MOVED, AND WHY IT HAD TO
 *
 * The previous `--deployed-worker-only` flag lived inside `scripts/consumer-smoke-live.ts` and skipped
 * one call: the local `executeIntent`. Everything else stayed. That script reaches production by holding
 * production's own `DATABASE_URL`, so with the flag set it still opened the production store, still
 * seeded the provider registry, still wrote a treasury account, still supplied its own in-process policy
 * literal, and still constructed a Solana rail client from a local treasury key. A run like that proves
 * things about the script. It cannot prove anything about the deployed service, because every control
 * the deployed service enforces is advisory to a process with write access to its database.
 *
 * So the boundary is now an import boundary and a process boundary, not a branch. This file imports
 * `node:crypto`, `fetch`, and two leaf modules. It cannot construct a store, an orchestrator, a worker,
 * an adapter, a rail client or a signer, because none of them is reachable from here — asserted by
 * `scripts/test/proof-controller-imports.test.ts`, which walks the real graph.
 *
 * WHAT THE LOCAL PROCESS IS ALLOWED TO DO
 *
 * Parse arguments. Derive a tenant and an idempotency key. Verify the deployment's identity. Ask for a
 * preflight. Ask for a create. Poll for status. Fetch a public receipt. Test a duplicate. Print.
 *
 * Everything that costs money happens inside the deployed service, executed by its own worker, signed by
 * a key this process never sees.
 */

import {
  ALLOWED_ENV,
  ControllerRefusal,
  DEFAULT_DEPLOYMENT_EXPECTATION,
  EXECUTION_PLAN,
  assertArmedAndExecutable,
  assertDeploymentIdentity,
  assertExpectedReadiness,
  assertKeylessEnvironment,
  assertReadyToArm,
  buildIdempotencyKey,
  deriveTenant,
  isIntentId,
  readControllerEnv,
  requestHash,
  type ControllerRequest,
  type DeploymentInfoResponse,
  type PlanResponse,
} from "./contract";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

const ok = (s: string): void => console.log(`  ${green("✓")} ${s}`);
const field = (k: string, v: string): void => console.log(`     ${k.padEnd(28)} ${v}`);
const step = (n: number, s: string): void => console.log(`\n${bold(`${String(n).padStart(2)}. ${s}`)}`);

/** A terminal state the controller stops polling on. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
  "MANUAL_REVIEW",
]);

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

// ── the transport ────────────────────────────────────────────────────────────

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * One place that talks to production, so there is one place that can be reviewed for what it sends.
 *
 * The operator token goes in a header and is never logged, never echoed into an error, and never placed
 * in a URL — a URL would reach access logs and proxy logs on both ends. A non-JSON body is surfaced as a
 * truncated string rather than parsed loosely: an HTML error page from an edge proxy is a completely
 * different fact from a JSON refusal, and collapsing them would let "the proxy is broken" read as "the
 * request was refused".
 */
async function call(
  env: { readonly aspUrl: string; readonly opsToken: string },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(`${env.aspUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.opsToken}`,
      "user-agent": "untch-proof-controller/2.0 (deployed-worker-only)",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = { __nonJsonBody: text.slice(0, 400) };
  }
  return { status: res.status, body: parsed };
}

/** An unauthenticated read. The public receipt must be verifiable without a credential, or it is not public. */
async function publicGet(url: string): Promise<HttpResult> {
  const res = await fetch(url, { headers: { "user-agent": "untch-proof-controller/2.0" } });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = { __nonJsonBody: text.slice(0, 400) };
  }
  return { status: res.status, body: parsed };
}

// ── the run ──────────────────────────────────────────────────────────────────

export async function runController(): Promise<void> {
  /**
   * The keyless check runs FIRST, before the plan is printed and before any URL is parsed.
   *
   * The plan claims local execution is disabled. Printing that claim and then discovering the process
   * holds a database credential would mean the claim had already been made falsely.
   */
  assertKeylessEnvironment(process.env);
  const env = readControllerEnv(process.env, { allowLoopbackHttp: has("allow-loopback-http") });

  const preflightOnly = has("preflight-only");
  const provider = arg("provider") ?? "purch";
  const capability = arg("capability") ?? "shop.search";
  const policyId = arg("policy-id") ?? "";
  const intentId = arg("intent-id") ?? "";
  const owner = arg("owner") ?? "operator:untch-proof";
  const query = arg("query") ?? "wireless mouse";
  const maxProviderAmount = arg("max-usdc") ?? "0.020000";
  const expiryMinutes = Number(arg("expiry-minutes") ?? "15");

  if (!has("operator-funded")) {
    throw new ControllerRefusal(
      "FUNDING_MODE_NOT_STATED",
      "pass --operator-funded. The funding mode decides whether a funding receipt asserts that money " +
        "arrived, so it is never defaulted.",
    );
  }
  if (policyId === "") {
    throw new ControllerRefusal(
      "POLICY_ID_MISSING",
      "pass --policy-id <id>. The controller never seeds a policy and never falls back to one: an " +
        "intent has to name a policy that already exists in the production store.",
    );
  }
  if (!isIntentId(intentId)) {
    throw new ControllerRefusal(
      "INTENT_ID_MISSING",
      "pass --intent-id ci_<24 lowercase hex>. The controller never mints one, because the proof gate " +
        "must name the exact intent before production is armed.",
    );
  }
  if (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0 || expiryMinutes > 60) {
    throw new ControllerRefusal("EXPIRY_INVALID", "--expiry-minutes must be a positive number under 60");
  }

  const tenantId = deriveTenant(policyId, arg("tenant-id"));
  const requestBody: Readonly<Record<string, unknown>> = { query };
  const expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();

  const req: ControllerRequest = {
    intentId,
    policyId,
    tenantId,
    owner,
    provider,
    capability,
    request: requestBody,
    providerRef: capability,
    maxProviderAmount,
    expectedSettlementChain: SOLANA_MAINNET,
    expectedSettlementAsset: "USDC",
    fundingMode: "operator-funded",
    idempotencyKey: buildIdempotencyKey({
      intentId,
      policyId,
      provider,
      capability,
      request: requestBody,
      maxProviderAmount,
      expiresAt,
    }),
    expiresAt,
  };

  // ── 1. the plan ────────────────────────────────────────────────────────────
  step(1, "EXECUTION PLAN");
  for (const [k, v] of EXECUTION_PLAN) field(k, v);
  console.log(
    dim(
      `\n     Reads only: ${ALLOWED_ENV.join(", ")}.\n` +
        "     Holds no database credential, no signer, no provider credential and no worker.",
    ),
  );

  // ── 2. deployment identity ─────────────────────────────────────────────────
  step(2, "DEPLOYMENT IDENTITY");
  const health = await publicGet(`${env.aspUrl}/healthz`);
  const infoRes = await call(env, "GET", "/internal/deployment-info");
  if (infoRes.status !== 200) {
    throw new ControllerRefusal(
      "DEPLOYMENT_INFO_UNREADABLE",
      `GET /internal/deployment-info answered ${infoRes.status}`,
      [JSON.stringify(infoRes.body).slice(0, 400)],
    );
  }
  const info = infoRes.body as DeploymentInfoResponse;
  assertDeploymentIdentity(
    info,
    {
      expectedServingCommit: env.expectedServingCommit,
      expectedMigration: arg("expect-migration") ?? DEFAULT_DEPLOYMENT_EXPECTATION.expectedMigration,
      expectedRpcHost: DEFAULT_DEPLOYMENT_EXPECTATION.expectedRpcHost,
      requireBaseRail: DEFAULT_DEPLOYMENT_EXPECTATION.requireBaseRail,
    },
    health.status,
  );
  ok("the deployment answering is the deployment expected");
  field("serving commit", String(info.commit));
  field("serving deployment", String(info.railwayDeploymentId));
  field("phase", String(info.phase));
  field("migration", String(info.migrationVersion));
  field("settlement rails", (info.settlementRails ?? []).join(", "));
  field("solana signer", String(info.solana?.signer));
  field("solana execution", String(info.solana?.execution));
  field("proof mode", String(info.proofGate?.proofMode));
  field("solana rpc", `${String(info.solana?.rpcHost)} (${String(info.solana?.rpcMode)})`);

  // ── 3. preflight ───────────────────────────────────────────────────────────
  step(3, "REMOTE PREFLIGHT — production says what it would do. Nothing is written.");
  const preflight = await call(env, "POST", "/internal/consumer/intents/preflight", {
    intentId: req.intentId,
    tenantId: req.tenantId,
    owner: req.owner,
    provider: req.provider,
    capability: req.capability,
    request: req.request,
    providerRef: req.providerRef,
    maxProviderAmount: req.maxProviderAmount,
    expectedSettlementChain: req.expectedSettlementChain,
    expectedSettlementAsset: req.expectedSettlementAsset,
    fundingMode: req.fundingMode,
    idempotencyKey: req.idempotencyKey,
    expiresAt: req.expiresAt,
  });
  if (preflight.status !== 200) {
    throw new ControllerRefusal(
      "PREFLIGHT_FAILED",
      `the preflight route answered ${preflight.status}`,
      [JSON.stringify(preflight.body).slice(0, 800)],
    );
  }
  const plan = preflight.body as PlanResponse;
  field("readinessClass", String(plan.readinessClass));
  field("accepted", String(plan.accepted));
  field("policy", `${String(plan.expectedPolicyPath?.policyId)} (${String(plan.expectedPolicyPath?.status)})`);
  field("production maturity", JSON.stringify(plan.productionMaturity));
  field("public maturity", String(plan.publicMaturity));
  field("settlement", JSON.stringify(plan.expectedSettlement));
  field("max authorised", String(plan.maxAuthorisedAmount));
  field("idempotency key", `sha256:${requestHash({ k: req.idempotencyKey }).slice(2, 18)}…`);
  field("request hash", requestHash(req.request));
  for (const r of plan.refusals ?? []) console.log(`     ${dim("refusal")} ${r.code}: ${r.message}`);

  if (preflightOnly) {
    /**
     * The expectation is STATED, not assumed.
     *
     * Defaults to READY_TO_ARM because that is the pre-arming check and the one an operator runs most,
     * but an armed deployment is a legitimate posture and a run that meant to confirm it says so.
     */
    const expected = arg("expect-readiness") ?? "READY_TO_ARM";
    assertExpectedReadiness(plan, expected);
    // The structural facts are checked for BOTH classes: an armed deployment whose policy vanished is
    // not something to proceed from either.
    assertReadyToArm(plan, {
      policyId: req.policyId,
      provider: req.provider,
      capability: req.capability,
      publicMaturity: "BETA",
    });
    console.log(`\n  ${green(expected)} — production is where this run expected it to be.`);
    console.log(
      dim(
        "     No intent was created, no reservation was made, no queue row was written, no provider was\n" +
          "     called and no payment occurred. Preflight writes nothing.",
      ),
    );
    return;
  }

  assertArmedAndExecutable(plan);
  ok("ARMED_AND_EXECUTABLE — preflight accepted this exact scope");

  // ── 4. create ──────────────────────────────────────────────────────────────
  step(4, "REMOTE CREATE — production creates, decides, reserves and queues. The worker executes.");
  const created = await call(env, "POST", "/internal/consumer/intents", {
    intentId: req.intentId,
    tenantId: req.tenantId,
    owner: req.owner,
    provider: req.provider,
    capability: req.capability,
    request: req.request,
    providerRef: req.providerRef,
    maxProviderAmount: req.maxProviderAmount,
    expectedSettlementChain: req.expectedSettlementChain,
    expectedSettlementAsset: req.expectedSettlementAsset,
    fundingMode: req.fundingMode,
    idempotencyKey: req.idempotencyKey,
    expiresAt: req.expiresAt,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new ControllerRefusal(
      "CREATE_REFUSED",
      `the create route answered ${created.status}; no intent was created`,
      [JSON.stringify(created.body).slice(0, 800)],
    );
  }
  const createdBody = created.body as Record<string, unknown>;
  ok(`intent ${String(createdBody.intentId)} is ${String(createdBody.state)}`);
  field("next action", String(createdBody.nextAction));
  field("decision", JSON.stringify(createdBody.decision));
  field("reservation", JSON.stringify(createdBody.reservation));
  field("quoted total", String(createdBody.quotedTotal));

  // ── 5. poll production ─────────────────────────────────────────────────────
  step(5, "PRODUCTION EVIDENCE — polled from the production store through the operator read route.");
  const deadline = Date.now() + 5 * 60_000;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const view = await call(env, "GET", `/internal/consumer/intents/${req.intentId}`);
    if (view.status !== 200) {
      throw new ControllerRefusal("STATUS_UNREADABLE", `the read route answered ${view.status}`, [
        JSON.stringify(view.body).slice(0, 400),
      ]);
    }
    last = view.body as Record<string, unknown>;
    const state = String(last.state);
    console.log(`     ${dim(new Date().toISOString())} ${state}`);
    if (TERMINAL_STATES.has(state)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (last === null) throw new ControllerRefusal("NO_STATUS", "production returned no view of the intent");

  const finalState = String(last.state);
  field("final state", finalState);
  field("policy", JSON.stringify(last.policy));
  field("reservation", JSON.stringify(last.reservation));
  field("executions", JSON.stringify(last.executions));
  field("delivery", JSON.stringify(last.delivery));
  field("ledger", JSON.stringify(last.ledger));
  field("receiptId", String(last.receiptId));
  field("public receipt", String(last.publicReceiptUrl));
  console.log(dim("     source: production ASP (its own store, over the authenticated operator route)"));

  // ── 6. the public receipt, verified without a credential ───────────────────
  step(6, "PUBLIC RECEIPT — fetched unauthenticated, so it is verifiable by anyone.");
  const receiptUrl = typeof last.publicReceiptUrl === "string" ? last.publicReceiptUrl : null;
  if (receiptUrl === null) {
    console.log(`  ${red("!")} production recorded no public receipt URL for this intent`);
  } else {
    const receipt = await publicGet(receiptUrl);
    field("HTTP", String(receipt.status));
    field("url", receiptUrl);
    if (receipt.status === 200) {
      ok("the public receipt is readable with no credential");
      console.log(dim("     source: public receipt endpoint"));
    } else {
      console.log(`  ${red("!")} the public receipt did not answer 200`);
    }
  }

  // ── 7. duplicates ──────────────────────────────────────────────────────────
  step(7, "DUPLICATE PROOF — the same request replays safely; a conflicting one is refused.");
  const replay = await call(env, "POST", "/internal/consumer/intents", {
    intentId: req.intentId,
    tenantId: req.tenantId,
    owner: req.owner,
    provider: req.provider,
    capability: req.capability,
    request: req.request,
    providerRef: req.providerRef,
    maxProviderAmount: req.maxProviderAmount,
    expectedSettlementChain: req.expectedSettlementChain,
    expectedSettlementAsset: req.expectedSettlementAsset,
    fundingMode: req.fundingMode,
    idempotencyKey: req.idempotencyKey,
    expiresAt: req.expiresAt,
  });
  const replayBody = replay.body as Record<string, unknown>;
  field("identical replay", `HTTP ${replay.status} ${String(replayBody.code ?? replayBody.state ?? "")}`);
  if (replay.status === 200 || replay.status === 409) {
    ok("an identical replay produced no second intent and no second payment");
  } else {
    console.log(`  ${red("!")} an identical replay answered ${replay.status}, which is neither a safe replay nor a refusal`);
  }

  /**
   * The conflicting duplicate: same intent id, same idempotency key, DIFFERENT request.
   *
   * This is the case that matters. An identical replay being safe is table stakes; the dangerous
   * request is one that reuses an authorisation's identity to buy something else. Production must
   * refuse it, and it must refuse it without creating anything.
   */
  const conflicting = await call(env, "POST", "/internal/consumer/intents", {
    intentId: req.intentId,
    tenantId: req.tenantId,
    owner: req.owner,
    provider: req.provider,
    capability: req.capability,
    request: { query: `${query} (conflicting duplicate probe)` },
    providerRef: req.providerRef,
    maxProviderAmount: req.maxProviderAmount,
    expectedSettlementChain: req.expectedSettlementChain,
    expectedSettlementAsset: req.expectedSettlementAsset,
    fundingMode: req.fundingMode,
    idempotencyKey: req.idempotencyKey,
    expiresAt: req.expiresAt,
  });
  const conflictBody = conflicting.body as Record<string, unknown>;
  field("conflicting replay", `HTTP ${conflicting.status} ${String(conflictBody.code ?? "")}`);
  if (conflicting.status >= 400) {
    ok("a conflicting duplicate was refused");
  } else {
    console.log(`  ${red("!")} a conflicting duplicate was NOT refused. This is a finding, not a pass.`);
  }

  step(8, "RESULT");
  if (finalState === "COMPLETED") {
    console.log(`  ${green("COMPLETED")} — one production intent, executed by the deployed worker.`);
  } else {
    console.log(`  ${red(finalState)} — the intent did not complete. Read the evidence above before retrying anything.`);
    console.log(
      dim(
        "     Never create a second intent. Inspect the gate, the stored signature, the Solana\n" +
          "     transaction and the production ledger first: a failed attempt and an ambiguous\n" +
          "     settlement produce the same intent state, and only one of them is safe to re-run.",
      ),
    );
    process.exitCode = 1;
  }
}

runController().catch((err: unknown) => {
  if (err instanceof ControllerRefusal) {
    console.error(`\n${red("REFUSED")} ${err.code}`);
    console.error(`  ${err.message}`);
    for (const line of err.detail) console.error(`  ${line}`);
    process.exit(2);
  }
  console.error(`\n${red("CONTROLLER ERROR")} ${(err as Error).message}`);
  process.exit(1);
});
