import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryConsumerStore } from "../src/repo-memory";
import { ProviderRegistry, publicToolStateFor, railHasStandingSigner } from "../src/registry";
import { isProviderError } from "../src/errors";
import type { ProviderCapabilityRecord, ProviderRecord } from "../src/repo";

/**
 * A verified PROVIDER does not make its capabilities executable. Each capability row is the boundary.
 *
 * This is the control that makes the narrow promotion safe. Purch is verified at the provider level
 * because shop.search completed a real settled payment and a real delivery. Three sibling capabilities
 * have no such evidence, and one of them, shop.purchase, buys physical goods. If provider maturity
 * carried the whole provider over the execution floor, promoting search would have quietly armed a
 * purchase route on the same evidence, which is the most expensive possible reading of "verified".
 *
 * The registry takes the LOWER of provider and capability maturity, so the tests below are the
 * assertion that this stays true rather than a restatement of it. They exercise the real
 * `assertExecutable` with the real production floor and NO sandbox opt-in, because the promotion was
 * chosen specifically to avoid needing one.
 */

const PRODUCTION_GATE = { executionFloor: "verified", allowSandboxExecution: false } as const;

function provider(over: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    providerId: "purch",
    displayName: "Purch",
    maturity: "verified",
    baseUrl: "https://purch.example",
    protocol: "x402",
    chains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    provenance: "settled and delivered on 2026-07-29",
    enabled: true,
    ...over,
  } as ProviderRecord;
}

function capability(over: Partial<ProviderCapabilityRecord> = {}): ProviderCapabilityRecord {
  return {
    providerId: "purch",
    capability: "shop.search",
    maturity: "verified",
    notes: "",
    accessBlocker: null,
    ...over,
  } as ProviderCapabilityRecord;
}

async function registryWith(
  p: ProviderRecord,
  caps: readonly ProviderCapabilityRecord[],
): Promise<ProviderRegistry> {
  const store = new InMemoryConsumerStore();
  await store.upsertProvider(p);
  for (const c of caps) await store.upsertCapability(c);
  return new ProviderRegistry({ store, gate: PRODUCTION_GATE });
}

/** Assert a refusal, and that it is a refusal rather than a thrown internal error. */
async function refuses(reg: ProviderRegistry, providerId: string, cap: string): Promise<string> {
  try {
    await reg.assertExecutable(providerId, cap);
    assert.fail(`${providerId}/${cap} executed and must not have`);
  } catch (err) {
    assert.ok(isProviderError(err), `expected a ProviderError, got ${String(err)}`);
    return err.normalized.code;
  }
}

describe("the narrow verified promotion", () => {
  test("verified provider with verified shop.search CAN execute", async () => {
    const reg = await registryWith(provider(), [capability()]);
    const resolved = await reg.assertExecutable("purch", "shop.search");
    assert.equal(resolved.effectiveMaturity, "verified");
    // No sandbox opt-in was needed to get here, which is the point of promoting to verified.
    assert.equal(resolved.sandboxOverride, false);
  });

  test("verified provider with experimental shop.purchase CANNOT execute", async () => {
    // The expensive one. Physical goods, dynamic total, no settlement evidence.
    const reg = await registryWith(provider(), [
      capability(),
      capability({ capability: "shop.purchase", maturity: "experimental" }),
    ]);
    assert.equal(await refuses(reg, "purch", "shop.purchase"), "PROVIDER_NOT_EXECUTABLE");
  });

  test("verified provider with experimental shop.track CANNOT execute", async () => {
    const reg = await registryWith(provider(), [
      capability(),
      capability({ capability: "shop.track", maturity: "experimental" }),
    ]);
    assert.equal(await refuses(reg, "purch", "shop.track"), "PROVIDER_NOT_EXECUTABLE");
  });

  test("verified provider with experimental shop.quote CANNOT execute", async () => {
    const reg = await registryWith(provider(), [
      capability(),
      capability({ capability: "shop.quote", maturity: "experimental" }),
    ]);
    assert.equal(await refuses(reg, "purch", "shop.quote"), "PROVIDER_NOT_EXECUTABLE");
  });

  test("a capability that does not exist CANNOT execute, so vault routes stay unreachable", async () => {
    // Vault capabilities are absent on purpose: nothing has proven those endpoints exist. An absent row
    // must refuse rather than fall through to the provider's maturity.
    //
    // The code differs from the tests above, and the difference is worth pinning. A DECLARED capability
    // below the floor answers PROVIDER_NOT_EXECUTABLE, meaning "known, not trusted yet". An UNDECLARED
    // one answers CAPABILITY_UNAVAILABLE, meaning "no such thing here". Collapsing them would hide
    // whether a caller hit an evidence boundary or invented an endpoint.
    const reg = await registryWith(provider(), [capability()]);
    assert.equal(await refuses(reg, "purch", "vault.buy"), "CAPABILITY_UNAVAILABLE");
    assert.equal(await refuses(reg, "purch", "vault.search"), "CAPABILITY_UNAVAILABLE");
  });

  test("no other provider becomes executable", async () => {
    // Promotion is per provider. A second provider left experimental stays refused even while purch
    // executes from the same registry and the same floor.
    const store = new InMemoryConsumerStore();
    await store.upsertProvider(provider());
    await store.upsertCapability(capability());
    await store.upsertProvider(
      provider({ providerId: "stablemerch", displayName: "StableMerch", maturity: "experimental" }),
    );
    await store.upsertCapability(
      capability({ providerId: "stablemerch", capability: "merch.buy", maturity: "experimental" }),
    );
    const reg = new ProviderRegistry({ store, gate: PRODUCTION_GATE });

    await reg.assertExecutable("purch", "shop.search");
    assert.equal(await refuses(reg, "stablemerch", "merch.buy"), "PROVIDER_NOT_EXECUTABLE");
  });

  test("a disabled provider refuses even a verified capability", async () => {
    const reg = await registryWith(provider({ enabled: false }), [capability()]);
    await refuses(reg, "purch", "shop.search");
  });

  test("experimental is unexecutable with the sandbox opt-in ON, so the promotion was necessary", async () => {
    // The alternative route was sandbox plus a global opt-in. This records why that would not have
    // worked for an experimental capability: the escape hatch only ever applied to `sandbox`.
    const store = new InMemoryConsumerStore();
    await store.upsertProvider(provider());
    await store.upsertCapability(capability({ maturity: "experimental" }));
    const permissive = new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: true },
    });
    await refuses(permissive, "purch", "shop.search");
  });
});

describe("public product maturity is not internal execution trust", () => {
  test("verified with no standing signer reads BETA, not LIVE", () => {
    // The claim being avoided. `verified` says a payment settled and a delivery happened. LIVE says a
    // caller can use it now. Purch shop.search is the first and not the second, because the treasury
    // signer is removed after every bounded run.
    assert.equal(publicToolStateFor(provider(), capability(), false), "BETA");
  });

  test("verified with a standing signer reads LIVE", () => {
    assert.equal(publicToolStateFor(provider(), capability(), true), "LIVE");
  });

  test("the experimental siblings read SANDBOX publicly", () => {
    assert.equal(
      publicToolStateFor(provider(), capability({ capability: "shop.purchase", maturity: "experimental" }), false),
      "SANDBOX",
    );
  });

  test("standing availability is derived from configuration, not stored", () => {
    const solana = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

    // Disarmed: no signer at all.
    assert.equal(railHasStandingSigner(solana, {}), false);

    // Armed for a bounded proof. Proof mode is the opposite of ordinary availability, so this is still
    // not standing, which keeps the public label honest DURING a proof window as well as after it.
    assert.equal(
      railHasStandingSigner(solana, {
        CONSUMER_TREASURY_SOLANA_SECRET_KEY: "x",
        CONSUMER_SOLANA_EXECUTION_ENABLED: "1",
        CONSUMER_SOLANA_PROOF_MODE: "1",
      }),
      false,
    );

    // A persistent signer with no proof mode is the arrangement that would earn LIVE.
    assert.equal(
      railHasStandingSigner(solana, {
        CONSUMER_TREASURY_SOLANA_SECRET_KEY: "x",
        CONSUMER_SOLANA_EXECUTION_ENABLED: "1",
      }),
      true,
    );

    // Base keeps its key between calls, so it is standing whenever configured.
    assert.equal(railHasStandingSigner("eip155:8453", { CONSUMER_TREASURY_BASE_PRIVATE_KEY: "0xabc" }), true);
    assert.equal(railHasStandingSigner("eip155:8453", {}), false);
  });
});
