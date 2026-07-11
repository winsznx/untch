import type { Address, Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { X_LAYER_TESTNET_ID } from "../chain/chains";
import { makePublicClient } from "../wallet/provider";

/**
 * Server-side SIWE verification. Checks, in order: the message carries an address, its nonce is the
 * one THIS server issued (single-use replay defence), the signature actually verifies against that
 * address (EOA ecrecover, or EIP-1271 for a contract wallet via the public client), and the chain is
 * X Layer testnet. Any failure returns a reason rather than throwing.
 */

export interface SiweVerifyResult {
  readonly ok: boolean;
  readonly address?: Address;
  readonly reason?: string;
}

export async function verifySiweSignin(params: {
  message: string;
  signature: Hex;
  expectedNonce: string;
  expectedDomain: string;
}): Promise<SiweVerifyResult> {
  const parsed = parseSiweMessage(params.message);
  if (!parsed.address) return { ok: false, reason: "message has no address" };
  if (parsed.nonce !== params.expectedNonce) return { ok: false, reason: "nonce mismatch or expired" };
  if (parsed.chainId !== X_LAYER_TESTNET_ID) return { ok: false, reason: "wrong chain" };

  const client = makePublicClient();
  const valid = await client.verifySiweMessage({
    message: params.message,
    signature: params.signature,
    nonce: params.expectedNonce,
    domain: params.expectedDomain,
  });
  if (!valid) return { ok: false, reason: "signature did not verify" };
  return { ok: true, address: parsed.address };
}
