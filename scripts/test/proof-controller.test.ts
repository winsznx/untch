import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ENV,
  ControllerRefusal,
  EXECUTION_PLAN,
  FORBIDDEN_LOCAL_ENV,
  assertArmedAndExecutable,
  assertDeploymentIdentity,
  assertKeylessEnvironment,
  assertReadyToArm,
  buildIdempotencyKey,
  deriveTenant,
  readControllerEnv,
  type DeploymentInfoResponse,
  type PlanResponse,
} from "../proof-controller/contract";
import { tenantForPolicy } from "../../services/asp/src/consumer/tenant";

/**
 * What the controller REFUSES is the whole of what it is for, so this suite is mostly refusals.
 *
 * The one thing it cannot test from here is the property that matters most — that this process could not
 * execute a payment even if it wanted to. That is not a behaviour, it is an absence, and an absence is
 * proven by walking the import graph rather than by calling a function. See
 * `proof-controller-imports.test.ts`.
 */

const GOOD_COMMIT = "015223129d6b664e9f32927f7765e63fb73a0b8d";

const GOOD_ENV = {
  UNTCH_ASP_URL: "https://asp.untch.xyz",
  INTERNAL_OPS_TOKEN: "an-operator-token-that-is-never-logged",
  UNTCH_EXPECTED_SERVING_COMMIT: GOOD_COMMIT,
} satisfies NodeJS.ProcessEnv;

function readyInfo(over: Partial<DeploymentInfoResponse> = {}): DeploymentInfoResponse {
  return {
    phase: "READY",
    commit: GOOD_COMMIT,
    attested: true,
    railwayDeploymentId: "a645632c-f5c7-4bc5-85c9-032530635c41",
    migrationVersion: "012_settlement_account_registration.sql",
    settlementRails: ["eip155:8453"],
    proofGate: { code: "present", schema: "ready", proofMode: "disabled" },
    solana: {
      signer: "absent",
      execution: "disabled",
      rpcHost: "solana-mainnet.g.alchemy.com",
      rpcMode: "read-only",
    },
    ...over,
  };
}

const EXPECTATION = {
  expectedServingCommit: GOOD_COMMIT,
  expectedMigration: "012_settlement_account_registration.sql",
  expectedRpcHost: "solana-mainnet.g.alchemy.com",
  requireBaseRail: true,
} as const;

function readyPlan(over: Partial<PlanResponse> = {}): PlanResponse {
  return {
    accepted: false,
    readinessClass: "READY_TO_ARM",
    refusals: [{ code: "EXECUTION_CONTROLS_DISABLED", message: "purch is switched off" }],
    expectedPolicyPath: { policyId: "4242", found: true, status: "ACTIVE" },
    productionMaturity: { provider: "verified", capability: "verified", effective: "verified" },
    publicMaturity: "BETA",
    expectedSettlement: { accountRegistered: true, accountFunded: true },
    idempotency: { duplicate: false },
    ...over,
  };
}

function refusalCode(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ControllerRefusal, `expected a ControllerRefusal, got ${String(err)}`);
    return err.code;
  }
  return assert.fail("expected a refusal, got none");
}

describe("the controller refuses an environment that could act locally", () => {
  /**
   * The defect this replaces, stated as a test.
   *
   * PASS 1's `--deployed-worker-only` ran with production's `DATABASE_URL` in scope and skipped exactly
   * one call. Everything it reported was therefore evidence about the script, because a process holding
   * write access to the store can step around every control the service enforces.
   */
  test("DATABASE_URL alone is enough to refuse", () => {
    const code = refusalCode(() => assertKeylessEnvironment({ ...GOOD_ENV, DATABASE_URL: "postgres://x/y" }));
    assert.equal(code, "CONTROLLER_ENVIRONMENT_NOT_KEYLESS");
  });

  test("every forbidden variable is refused on its own", () => {
    for (const name of FORBIDDEN_LOCAL_ENV) {
      const code = refusalCode(() => assertKeylessEnvironment({ ...GOOD_ENV, [name]: "present" }));
      assert.equal(code, "CONTROLLER_ENVIRONMENT_NOT_KEYLESS", `${name} must be refused`);
    }
  });

  test("the refusal names the variables and does not echo their values", () => {
    const secret = "a-treasury-secret-that-must-not-be-printed";
    try {
      assertKeylessEnvironment({ ...GOOD_ENV, CONSUMER_TREASURY_SOLANA_SECRET_KEY: secret });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof ControllerRefusal);
      const rendered = [err.message, ...err.detail].join("\n");
      assert.ok(rendered.includes("CONSUMER_TREASURY_SOLANA_SECRET_KEY"));
      assert.ok(!rendered.includes(secret), "a refusal must never echo the value it refused");
    }
  });

  /** An empty string is not a credential. Refusing it would block a legitimate `env -u`-shaped run. */
  test("an empty forbidden variable is not a credential", () => {
    assert.doesNotThrow(() => assertKeylessEnvironment({ ...GOOD_ENV, DATABASE_URL: "" }));
    assert.doesNotThrow(() => assertKeylessEnvironment({ ...GOOD_ENV, DATABASE_URL: "   " }));
  });

  test("the clean environment passes", () => {
    assert.doesNotThrow(() => assertKeylessEnvironment(GOOD_ENV));
  });

  test("the allowlist is exactly the three documented variables", () => {
    assert.deepEqual([...ALLOWED_ENV], [
      "UNTCH_ASP_URL",
      "INTERNAL_OPS_TOKEN",
      "UNTCH_EXPECTED_SERVING_COMMIT",
    ]);
  });
});

describe("the controller refuses an incomplete configuration", () => {
  test("a missing ASP URL, token or expected commit each name themselves", () => {
    assert.equal(refusalCode(() => readControllerEnv({ ...GOOD_ENV, UNTCH_ASP_URL: "" })), "ASP_URL_MISSING");
    assert.equal(refusalCode(() => readControllerEnv({ ...GOOD_ENV, INTERNAL_OPS_TOKEN: "" })), "OPS_TOKEN_MISSING");
    assert.equal(
      refusalCode(() => readControllerEnv({ ...GOOD_ENV, UNTCH_EXPECTED_SERVING_COMMIT: "" })),
      "EXPECTED_COMMIT_MISSING",
    );
  });

  /**
   * A short SHA is refused.
   *
   * The point of pinning the commit is that a prefix match and an identity are different claims, and a
   * deployment serving a different commit with the same seven leading characters would satisfy the first.
   */
  test("a short commit is refused", () => {
    assert.equal(
      refusalCode(() => readControllerEnv({ ...GOOD_ENV, UNTCH_EXPECTED_SERVING_COMMIT: "0152231" })),
      "EXPECTED_COMMIT_MALFORMED",
    );
  });

  test("a plaintext ASP URL is refused, because the operator token travels on it", () => {
    assert.equal(
      refusalCode(() => readControllerEnv({ ...GOOD_ENV, UNTCH_ASP_URL: "http://asp.untch.xyz" })),
      "ASP_URL_NOT_HTTPS",
    );
  });

  test("a trailing slash is normalised rather than refused", () => {
    assert.equal(readControllerEnv({ ...GOOD_ENV, UNTCH_ASP_URL: "https://asp.untch.xyz///" }).aspUrl, "https://asp.untch.xyz");
  });
});

describe("the tenant is derived from the policy, never declared beside it", () => {
  test("it derives through the canonical helper", () => {
    assert.equal(deriveTenant("4242", null), tenantForPolicy("4242"));
    assert.equal(deriveTenant("4242", null), "policy:4242");
  });

  test("a supplied tenant that agrees is accepted", () => {
    assert.equal(deriveTenant("4242", "policy:4242"), "policy:4242");
  });

  /**
   * The second binding this convention exists to prevent.
   *
   * Accepting `policyId` and `tenantId` as independent inputs would let a request name one policy and be
   * evaluated in another tenant's partition. The derived value always wins, and a disagreement stops the
   * run rather than being silently overridden.
   */
  test("a supplied tenant that disagrees is refused, not overridden", () => {
    assert.equal(refusalCode(() => deriveTenant("4242", "policy:9001")), "TENANT_MISMATCH");
    assert.equal(refusalCode(() => deriveTenant("4242", "4242")), "TENANT_MISMATCH");
    assert.equal(refusalCode(() => deriveTenant("4242", "tenant:4242")), "TENANT_MISMATCH");
  });

  test("a policy id that is not an on-chain registry id is refused", () => {
    for (const bad of ["", "abc", "policy:1", "42.0", "-1", "0x2a"]) {
      assert.equal(refusalCode(() => deriveTenant(bad, null)), "POLICY_ID_MALFORMED", `${bad} must be refused`);
    }
  });
});

describe("the idempotency key binds the whole request", () => {
  const base = {
    intentId: "ci_959efdca63118f79525841db",
    policyId: "4242",
    provider: "purch",
    capability: "shop.search",
    request: { query: "wireless mouse" },
    maxProviderAmount: "0.020000",
    expiresAt: "2026-07-30T13:00:00.000Z",
  };

  test("it is stable for an identical request, so a retry replays rather than re-authorises", () => {
    assert.equal(buildIdempotencyKey(base), buildIdempotencyKey({ ...base }));
    // Key order must not matter: a re-serialised request is the same request.
    assert.equal(
      buildIdempotencyKey(base),
      buildIdempotencyKey({ ...base, request: { query: "wireless mouse" } }),
    );
  });

  test("changing any bound field changes the key", () => {
    const variants = [
      { intentId: "ci_959efdca63118f79525841dc" },
      { policyId: "4243" },
      { provider: "stabledomains" },
      { capability: "shop.quote" },
      { request: { query: "something else" } },
      { maxProviderAmount: "0.030000" },
      { expiresAt: "2026-07-30T14:00:00.000Z" },
    ];
    for (const over of variants) {
      assert.notEqual(
        buildIdempotencyKey(base),
        buildIdempotencyKey({ ...base, ...over }),
        `${Object.keys(over)[0]} must change the key`,
      );
    }
  });

  test("it names the intent, so an operator reading a log can tell which proof it belongs to", () => {
    assert.ok(buildIdempotencyKey(base).startsWith(`proof-${base.intentId}-`));
  });
});

describe("deployment identity is verified before anything else", () => {
  test("a matching deployment passes", () => {
    assert.doesNotThrow(() => assertDeploymentIdentity(readyInfo(), EXPECTATION, 200));
  });

  /**
   * The incident this exists for.
   *
   * On 2026-07-29 two builds carrying a new spending gate failed, no container was created, and an older
   * container kept serving. Authority was granted on the belief the new code was live. A commit mismatch
   * has to stop the run before the preflight route is called, which the runner enforces by ordering and
   * this asserts by refusal.
   */
  test("a commit mismatch is refused", () => {
    const code = refusalCode(() =>
      assertDeploymentIdentity(readyInfo({ commit: "f".repeat(40) }), EXPECTATION, 200),
    );
    assert.equal(code, "DEPLOYMENT_IDENTITY_MISMATCH");
  });

  test("each single defect is refused on its own", () => {
    const cases: readonly (readonly [string, Partial<DeploymentInfoResponse>])[] = [
      ["not READY", { phase: "STARTING" }],
      ["unattested", { attested: false }],
      ["no commit", { commit: null }],
      ["no deployment id", { railwayDeploymentId: null }],
      ["wrong migration", { migrationVersion: "011_solana_proof_gate.sql" }],
      ["gate code absent", { proofGate: { code: "absent", schema: "ready", proofMode: "disabled" } }],
      ["gate schema not ready", { proofGate: { code: "present", schema: "pending", proofMode: "disabled" } }],
      ["no proof-mode state", { proofGate: { code: "present", schema: "ready" } }],
      ["base rail missing", { settlementRails: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] }],
      ["unexpected rpc host", { solana: { signer: "absent", execution: "disabled", rpcHost: "api.mainnet-beta.solana.com", rpcMode: "read-only" } }],
      ["no signer state", { solana: { execution: "disabled", rpcHost: "solana-mainnet.g.alchemy.com" } }],
      ["no execution state", { solana: { signer: "absent", rpcHost: "solana-mainnet.g.alchemy.com" } }],
    ];
    for (const [label, over] of cases) {
      assert.equal(
        refusalCode(() => assertDeploymentIdentity(readyInfo(over), EXPECTATION, 200)),
        "DEPLOYMENT_IDENTITY_MISMATCH",
        `${label} must be refused`,
      );
    }
  });

  test("a failing healthz is refused even when deployment-info looks correct", () => {
    assert.equal(
      refusalCode(() => assertDeploymentIdentity(readyInfo(), EXPECTATION, 503)),
      "DEPLOYMENT_IDENTITY_MISMATCH",
    );
  });

  /** Every mismatch at once, so an operator fixes one deploy rather than three. */
  test("all mismatches are collected, not just the first", () => {
    try {
      assertDeploymentIdentity(readyInfo({ phase: "STARTING", attested: false, commit: null }), EXPECTATION, 503);
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof ControllerRefusal);
      assert.ok(err.detail.length >= 4, `expected several problems, got ${err.detail.length}`);
    }
  });

  /**
   * An armed deployment must still pass identity.
   *
   * Identity is about WHICH code is serving, not about whether it is armed. A verifier that refused an
   * armed deployment would make the second preflight impossible.
   */
  test("an armed deployment still satisfies identity", () => {
    assert.doesNotThrow(() =>
      assertDeploymentIdentity(
        readyInfo({
          proofGate: { code: "present", schema: "ready", proofMode: "enabled" },
          solana: { signer: "present", execution: "enabled", rpcHost: "solana-mainnet.g.alchemy.com", rpcMode: "read-write" },
        }),
        EXPECTATION,
        200,
      ),
    );
  });
});

describe("readiness is asserted against the plan's own fields", () => {
  const expect = { policyId: "4242", provider: "purch", capability: "shop.search", publicMaturity: "BETA" };

  test("READY_TO_ARM with every structural fact holding passes", () => {
    assert.doesNotThrow(() => assertReadyToArm(readyPlan(), expect));
  });

  test("STRUCTURAL_BLOCKED is refused", () => {
    assert.equal(
      refusalCode(() => assertReadyToArm(readyPlan({ readinessClass: "STRUCTURAL_BLOCKED" }), expect)),
      "NOT_READY_TO_ARM",
    );
  });

  /**
   * A structural fact is checked directly, not inferred from the absence of a refusal code.
   *
   * "No refusal mentioned the policy" and "the policy exists" are different statements. Only the second
   * is worth arming a treasury on.
   */
  test("each structural fact is checked even when the class says READY_TO_ARM", () => {
    const cases: readonly (readonly [string, Partial<PlanResponse>])[] = [
      ["policy absent", { expectedPolicyPath: { policyId: "4242", found: false, status: null } }],
      ["policy not active", { expectedPolicyPath: { policyId: "4242", found: true, status: "PAUSED" } }],
      ["a different policy", { expectedPolicyPath: { policyId: "9001", found: true, status: "ACTIVE" } }],
      ["provider not verified", { productionMaturity: { provider: "sandbox", capability: "verified" } }],
      ["capability not verified", { productionMaturity: { provider: "verified", capability: "experimental" } }],
      ["public maturity wrong", { publicMaturity: "LIVE" }],
      ["account unregistered", { expectedSettlement: { accountRegistered: false, accountFunded: false } }],
      ["account unfunded", { expectedSettlement: { accountRegistered: true, accountFunded: false } }],
      ["idempotency key already used", { idempotency: { duplicate: true } }],
    ];
    for (const [label, over] of cases) {
      assert.equal(
        refusalCode(() => assertReadyToArm(readyPlan(over), expect)),
        "NOT_READY_TO_ARM",
        `${label} must be refused`,
      );
    }
  });

  test("the refusal carries production's own refusal list, so the operator sees both", () => {
    try {
      assertReadyToArm(readyPlan({ readinessClass: "STRUCTURAL_BLOCKED" }), expect);
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof ControllerRefusal);
      assert.ok(err.detail.some((d) => d.includes("EXECUTION_CONTROLS_DISABLED")));
    }
  });
});

describe("create is unreachable unless preflight said ARMED_AND_EXECUTABLE", () => {
  test("both signals together pass", () => {
    assert.doesNotThrow(() =>
      assertArmedAndExecutable({ accepted: true, readinessClass: "ARMED_AND_EXECUTABLE", refusals: [] }),
    );
  });

  /**
   * Neither signal alone is enough.
   *
   * They are derived from the same refusal list, so a disagreement between them means the plan shape has
   * changed under the controller. Trusting whichever one happens to be permissive is how a controller
   * creates an intent production had refused.
   */
  test("either signal alone is refused", () => {
    assert.equal(
      refusalCode(() => assertArmedAndExecutable({ accepted: true, readinessClass: "READY_TO_ARM" })),
      "NOT_ARMED_AND_EXECUTABLE",
    );
    assert.equal(
      refusalCode(() => assertArmedAndExecutable({ accepted: false, readinessClass: "ARMED_AND_EXECUTABLE" })),
      "NOT_ARMED_AND_EXECUTABLE",
    );
    assert.equal(refusalCode(() => assertArmedAndExecutable({})), "NOT_ARMED_AND_EXECUTABLE");
  });

  test("the refusal explains what production said", () => {
    try {
      assertArmedAndExecutable({
        accepted: false,
        readinessClass: "READY_TO_ARM",
        refusals: [{ code: "PROOF_GATE_NOT_ARMED", message: "no gate" }],
      });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof ControllerRefusal);
      assert.ok(err.detail.some((d) => d.includes("PROOF_GATE_NOT_ARMED")));
    }
  });
});

describe("the printed plan cannot drift from what the controller does", () => {
  test("it states the mode and every disabled local capability", () => {
    const plan = new Map(EXECUTION_PLAN.map(([k, v]) => [k, v]));
    assert.equal(plan.get("MODE"), "DEPLOYED_WORKER_ONLY");
    assert.equal(plan.get("Controller"), "local");
    assert.equal(plan.get("Local database access"), "disabled");
    assert.equal(plan.get("Local provider execution"), "disabled");
    assert.equal(plan.get("Local signer"), "disabled");
    assert.equal(plan.get("Local worker"), "disabled");
    assert.equal(plan.get("Worker"), "Railway untch-asp");
    assert.equal(plan.get("Provider execution"), "Railway untch-asp");
  });

  /**
   * The four "disabled" lines are the claim. Each is backed by the keyless check refusing the credential
   * that would make it false, so the plan and the enforcement cannot diverge without a test failing.
   */
  test("each disabled claim has a credential whose presence would refuse the run", () => {
    for (const name of ["DATABASE_URL", "CONSUMER_TREASURY_SOLANA_SECRET_KEY"]) {
      assert.ok(FORBIDDEN_LOCAL_ENV.includes(name as never), `${name} must be refusable`);
    }
  });
});
