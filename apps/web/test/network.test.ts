import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { REQUIRED_CHAIN_ID, resolveNetworkAction } from "../lib/wallet/network";
import { buildSiweMessage } from "../lib/wallet/siwe";
import { X_LAYER_MAINNET_ID, X_LAYER_TESTNET_ID } from "../lib/chain/chains";

/**
 * Before/after proof for the chain-mismatch fix (same discipline as the concurrency-lock test).
 *
 * The reported failure: OKX Wallet left on Ethereum mainnet (chainId 1) never completes SIWE. Root cause is
 * that RainbowKit's sign handler reads `useAccount().chain?.id`, which wagmi leaves `undefined` for any chain
 * outside the configured set, and then silently returns — no message, no signature prompt. These tests pin
 * the two guarantees the fix adds: (1) the guard resolves an explicit switch for exactly that state (and any
 * other off-product chain), a no-op once the wallet is correct; (2) the SIWE message carries the wallet's
 * actual chainId verbatim, so wallet and message never silently disagree.
 */

const ETHEREUM_MAINNET = 1; // the chain OKX was reported parked on

test("REQUIRED_CHAIN_ID is the product chain (X Layer mainnet by default)", () => {
  assert.equal(REQUIRED_CHAIN_ID, X_LAYER_MAINNET_ID);
});

test("BEFORE→AFTER: a wallet parked on Ethereum mainnet is told to switch to X Layer product chain", () => {
  // #given a connected wallet on Ethereum mainnet — the exact state OKX was left in
  // #when the guard decides what to do before SIWE
  const action = resolveNetworkAction({ isConnected: true, chainId: ETHEREUM_MAINNET });
  // #then it requests an explicit switch to the product chain instead of letting the sign step silently bail
  assert.deepEqual(action, { kind: "switch", targetChainId: X_LAYER_MAINNET_ID });
});

test("general fix: every off-product chain switches, not just OKX/Ethereum", () => {
  // #given a range of chains a wallet could be parked on (Ethereum, Polygon, Base, Arbitrum, X Layer testnet)
  for (const wrong of [ETHEREUM_MAINNET, 137, 8453, 42161, X_LAYER_TESTNET_ID]) {
    // #when the guard resolves
    const action = resolveNetworkAction({ isConnected: true, chainId: wrong });
    // #then each is switched to the product chain
    assert.equal(action.kind, "switch", `chain ${wrong} should switch`);
  }
});

test("a wallet already on the product chain (mainnet) is ready — no gratuitous switch", () => {
  assert.deepEqual(resolveNetworkAction({ isConnected: true, chainId: X_LAYER_MAINNET_ID }), { kind: "ready" });
});

test("a disconnected or chain-unknown wallet needs no switch", () => {
  assert.deepEqual(resolveNetworkAction({ isConnected: false, chainId: undefined }), { kind: "ready" });
  assert.deepEqual(resolveNetworkAction({ isConnected: true, chainId: undefined }), { kind: "ready" });
});

test("SIWE message carries exactly the chainId it is given (rules out a hardcoded chainId)", () => {
  const common = {
    address: "0x1111111111111111111111111111111111111111" as Address,
    domain: "app.untch.xyz",
    uri: "https://app.untch.xyz",
    nonce: "abcdef0123456789",
    issuedAt: new Date("2026-07-12T00:00:00Z"),
    expirationTime: new Date("2026-07-12T00:10:00Z"),
  };
  // #given the wrong-chain state: the message would carry chainId 1, which the server's X Layer gate rejects
  const wrong = parseSiweMessage(buildSiweMessage({ ...common, chainId: ETHEREUM_MAINNET }));
  assert.equal(wrong.chainId, ETHEREUM_MAINNET);
  // #then after the guard switches, the same builder carries 196 — the product chain the server accepts
  const right = parseSiweMessage(buildSiweMessage({ ...common, chainId: X_LAYER_MAINNET_ID }));
  assert.equal(right.chainId, X_LAYER_MAINNET_ID);
});
