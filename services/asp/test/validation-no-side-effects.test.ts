import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { suppressExternalEffects } from "../src/consumer/preflight-validate-route";
import type { PreflightDeps } from "../src/handlers";

/**
 * A rolled-back validation must not reach the outside world.
 *
 * WHAT HAPPENED
 *
 * The first version of the validation route passed `preflightEngineDeps()` unchanged. Those deps
 * carry the escalation gateway and the receipt enqueuer, and both act on the connection pool rather
 * than on the caller's transaction. A run that rolled back its own writes perfectly still:
 *
 *   • created escalation esc_44c567b949fe against the user's real mainnet policy;
 *   • wrote three receipt rows queued for on-chain anchoring;
 *   • sent real Telegram, Discord and Slack messages to a person, who approved one.
 *
 * A ROLLBACK CANNOT UN-SEND A MESSAGE. So the fix is not a flag the gateway checks — a flag is
 * something a future edit forgets. The dependency is REMOVED, and these tests assert its absence.
 */

/** Every dependency present, each one recording if it was ever reached. */
function fullDeps(): { deps: PreflightDeps; fired: string[] } {
  const fired: string[] = [];
  const deps = {
    policyProvider: {} as PreflightDeps["policyProvider"],
    ledger: {} as PreflightDeps["ledger"],
    intentStore: {} as PreflightDeps["intentStore"],
    escalationGateway: {
      onEscalated: async () => {
        fired.push("escalationGateway");
      },
    },
    receiptEnqueuer: {
      enqueue: async () => {
        fired.push("receiptEnqueuer");
        return { receiptId: "0x00" as const, status: "QUEUED" as const };
      },
    } as unknown as PreflightDeps["receiptEnqueuer"],
    intentRegistry: {
      register: async () => {
        fired.push("intentRegistry");
        return {};
      },
    } as unknown as PreflightDeps["intentRegistry"],
    oracleSigner: {
      signSpend: async () => {
        fired.push("oracleSigner");
        return {};
      },
    } as unknown as PreflightDeps["oracleSigner"],
    scoreDataSource: null,
  } as unknown as PreflightDeps;
  return { deps, fired };
}

describe("the validation path cannot reach outside this process", () => {
  test("every outbound dependency is absent after suppression, not merely disabled", () => {
    const { deps } = fullDeps();
    const suppressed = suppressExternalEffects(deps) as Record<string, unknown>;

    for (const key of ["escalationGateway", "receiptEnqueuer", "intentRegistry", "oracleSigner"]) {
      // `in`, not a truthiness check: a key present and undefined would still let `deps.x?.()`
      // typecheck and would still be one edit away from firing.
      assert.equal(key in suppressed, false, `${key} survived suppression`);
    }
  });

  test("the dependencies the decision genuinely needs are kept", () => {
    const { deps } = fullDeps();
    const suppressed = suppressExternalEffects(deps) as Record<string, unknown>;
    // Removing these would make the validation stop exercising the real decision path, which is the
    // opposite failure: a proof that proves nothing.
    for (const key of ["policyProvider", "ledger", "intentStore"]) {
      assert.equal(key in suppressed, true, `${key} must survive: the decision needs it`);
    }
  });

  test("nothing fires, because there is nothing present to fire", async () => {
    const { deps, fired } = fullDeps();
    const suppressed = suppressExternalEffects(deps) as Record<string, unknown>;

    // Reach for each effect the way the handler would. Every one is absent, so every one is a no-op.
    await (suppressed.escalationGateway as { onEscalated?: () => Promise<void> } | undefined)?.onEscalated?.();
    await (suppressed.receiptEnqueuer as { enqueue?: () => Promise<void> } | undefined)?.enqueue?.();
    await (suppressed.intentRegistry as { register?: () => Promise<void> } | undefined)?.register?.();
    await (suppressed.oracleSigner as { signSpend?: () => Promise<void> } | undefined)?.signSpend?.();

    assert.deepEqual(fired, [], `these effects fired during a non-billable validation: ${fired.join(", ")}`);
  });

  test("the unsuppressed deps DO fire, so the test is testing something", async () => {
    const { deps, fired } = fullDeps();
    await deps.escalationGateway?.onEscalated({} as never);
    assert.deepEqual(fired, ["escalationGateway"], "the fixture must be capable of firing");
  });
});
