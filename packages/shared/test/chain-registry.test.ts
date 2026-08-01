import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CHAIN_FLAG_ALIASES,
  CHAIN_REGISTRY,
  DEFAULT_CHAIN_ID,
  DEPRECATED_CHAIN_IDS,
  PRODUCTION_VISIBLE_CHAIN_IDS,
  SIGNIN_CHAIN_IDS,
  chainRegistryEntry,
  isDeprecatedChain,
  signInRefusal,
} from "../src/chain-registry";
import { X_LAYER_MAINNET_ID, X_LAYER_TESTNET_ID } from "../src/chains";

/**
 * What is worth testing here is not that the registry lists three chains — it is the set of claims
 * four separate production surfaces got wrong independently. Each test below is one of those claims,
 * stated once, in the place that now owns it.
 */
describe("chain registry", () => {
  test("the retired testnet is listed, marked deprecated, and cannot be signed in on", () => {
    const retired = chainRegistryEntry(195);
    assert.ok(retired, "195 must be listed so it can be refused BY NAME rather than as unknown");
    assert.equal(retired.deprecated, true);
    assert.equal(retired.signIn, false);
    assert.equal(retired.productionVisible, false);
    assert.deepEqual(retired.rpcUrls, [], "a retired chain has no RPC to offer");
    assert.equal(isDeprecatedChain(195), true);
    assert.deepEqual(DEPRECATED_CHAIN_IDS, [195]);
  });

  test("the LIVE testnet is signable and the retired one is not", () => {
    assert.ok(SIGNIN_CHAIN_IDS.includes(X_LAYER_TESTNET_ID));
    assert.ok(SIGNIN_CHAIN_IDS.includes(X_LAYER_MAINNET_ID));
    assert.ok(!SIGNIN_CHAIN_IDS.includes(195), "signing in on a chain with no RPC proves nothing checkable");
  });

  test("refusing a retired chain says which chain replaced it", () => {
    const reason = signInRefusal(195);
    assert.ok(reason);
    assert.match(reason, /retired/);
    assert.match(reason, new RegExp(String(X_LAYER_TESTNET_ID)));
  });

  test("an unknown chain is refused without being called retired", () => {
    const reason = signInRefusal(1);
    assert.ok(reason);
    assert.ok(!/retired/.test(reason), "mainnet Ethereum was never an X Layer testnet");
  });

  test("only mainnet may be named by a public production surface", () => {
    assert.deepEqual(PRODUCTION_VISIBLE_CHAIN_IDS, [X_LAYER_MAINNET_ID]);
  });

  test("the default chain is the one production actually settles on", () => {
    assert.equal(DEFAULT_CHAIN_ID, X_LAYER_MAINNET_ID);
    const entry = chainRegistryEntry(DEFAULT_CHAIN_ID);
    assert.equal(entry?.status, "active-mainnet");
    assert.ok(entry?.settlementToken, "the default chain must have a confirmed settlement token");
    assert.ok(entry?.contracts, "the default chain must have deployed Untch contracts");
  });

  test("the testnet flag alias points at the testnet that answers", () => {
    assert.equal(CHAIN_FLAG_ALIASES["eip155:1952"], "CONSUMER_XLAYER_TESTNET_ENABLED");
    assert.equal(
      CHAIN_FLAG_ALIASES["eip155:195"],
      undefined,
      "enabling a rail must not be able to name a chain nothing can reach",
    );
  });

  test("every entry's CAIP-2 id agrees with its numeric chainId", () => {
    for (const e of CHAIN_REGISTRY) {
      assert.equal(e.caip2, `eip155:${e.chainId}`);
    }
  });

  test("no chain claims to be both deprecated and signable", () => {
    for (const e of CHAIN_REGISTRY) {
      if (e.deprecated) assert.equal(e.signIn, false);
      if (e.productionVisible) assert.equal(e.testnet, false);
    }
  });
});
