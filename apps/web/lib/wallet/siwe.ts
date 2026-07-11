import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { X_LAYER_TESTNET_ID } from "../chain/chains";

/**
 * SIWE (EIP-4361) message construction, shared by the client that signs and the server that verifies.
 *
 * Sign-in proves the operator controls the wallet — it is IDENTITY, not authority. Per §27's
 * control-channel authority boundary, a proven identity is enough to authorize dashboard-native
 * escalation approvals (exactly like a bound Telegram handle authorizes an approval without a fresh
 * signature each time). It authorizes NO on-chain write: policy and vault writes each need their own
 * transaction signed at the moment they happen. The statement says so in plain words.
 */

export const SIWE_STATEMENT =
  "Sign in to the Untch operator dashboard. This proves you control this wallet. " +
  "It authorizes no transaction and moves no funds.";

export interface SiweParams {
  readonly address: Address;
  readonly domain: string;
  readonly uri: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expirationTime: Date;
}

/** Build the exact EIP-4361 message string the wallet signs and the server later re-verifies. */
export function buildSiweMessage(p: SiweParams): string {
  return createSiweMessage({
    address: p.address,
    chainId: X_LAYER_TESTNET_ID,
    domain: p.domain,
    nonce: p.nonce,
    uri: p.uri,
    version: "1",
    statement: SIWE_STATEMENT,
    issuedAt: p.issuedAt,
    expirationTime: p.expirationTime,
  });
}
