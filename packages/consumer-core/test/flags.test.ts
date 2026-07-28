import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asset, chainFlagName, loadConsumerFlags } from "../src/index";

/**
 * Flag naming: two names, one meaning.
 *
 * The operational runbook and the Phase-3 brief were written against CONSUMER_BASE_ENABLED and
 * CONSUMER_BASE_USDC_ENABLED. The implementation derives names from CAIP-2, giving
 * CONSUMER_CHAIN_EIP155_8453_ENABLED. A documented flag that silently does nothing is the worst
 * possible outcome: an operator believes they enabled a rail and no error says otherwise.
 */
describe("flag aliases — the documented names work, and the canonical one wins", () => {
  const USDC = asset("base.usdc");
  const BASE = USDC.chain;

  test("the friendly chain name enables the rail", () => {
    const flags = loadConsumerFlags({ CONSUMER_BASE_ENABLED: "1" } as NodeJS.ProcessEnv);
    assert.equal(flags.chainEnabled(BASE), true);
  });

  test("the canonical chain name still enables the rail", () => {
    const flags = loadConsumerFlags({
      [chainFlagName(BASE)]: "1",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(flags.chainEnabled(BASE), true);
  });

  test("the friendly asset name enables the token", () => {
    const flags = loadConsumerFlags({ CONSUMER_BASE_USDC_ENABLED: "1" } as NodeJS.ProcessEnv);
    assert.equal(flags.assetEnabled(USDC), true);
  });

  test("a canonical OFF is not overridden by a stale friendly ON", () => {
    // Precedence is the point of the ordering: an operator who explicitly disabled a rail must not
    // have it re-enabled by a leftover variable from an older runbook.
    const flags = loadConsumerFlags({
      [chainFlagName(BASE)]: "0",
      CONSUMER_BASE_ENABLED: "1",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(flags.chainEnabled(BASE), false);
  });

  test("an unset canonical name is no vote at all, not a vote for off", () => {
    const flags = loadConsumerFlags({ CONSUMER_BASE_ENABLED: "1" } as NodeJS.ProcessEnv);
    assert.equal(flags.chainEnabled(BASE), true, "absence must not shadow the alias");
  });

  test("neither name set leaves the rail off", () => {
    assert.equal(loadConsumerFlags({} as NodeJS.ProcessEnv).chainEnabled(BASE), false);
  });

  test("a chain with no alias still works from its canonical name", () => {
    const flags = loadConsumerFlags({ CONSUMER_CHAIN_SOLANA_MAINNET_ENABLED: "1" } as NodeJS.ProcessEnv);
    assert.equal(flags.chainEnabled("solana:mainnet" as never), true);
  });

  test("the snapshot reports the name the operator actually used", () => {
    const flags = loadConsumerFlags({ CONSUMER_BASE_ENABLED: "1" } as NodeJS.ProcessEnv);
    const snap = flags.snapshot([]);
    assert.equal(snap.CONSUMER_BASE_ENABLED, true);
    assert.equal(snap[chainFlagName(BASE)], undefined, "an unset canonical must not be reported as false");
  });
});
