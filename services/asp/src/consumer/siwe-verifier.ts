/**
 * The SIWE signature check, on its own so a Worker can hold it.
 *
 * It used to live in `auth.ts`, which also carries the consumer auth config loader, the nonce store
 * and `tenantForPolicy` — a module that reads `process.env` at import and reaches for a `Pool`. The
 * Cloudflare account-link routes need the verifier and none of the rest, and importing the module to
 * get one function would pull all of it into the bundle.
 *
 * viem's `http` transport is `fetch`, so EOA ecrecover and the EIP-1271 contract-wallet path both work
 * unchanged on Workers. That matters more than it sounds: an OKX Agentic Wallet is a smart account, so
 * 1271 is the path a real user takes, not the fallback.
 */

import { createPublicClient, http, type Hex } from "viem";

export interface SiweVerifier {
  verify(args: { message: string; signature: Hex; nonce: string; domain: string }): Promise<boolean>;
}

/** The real one. EOA ecrecover, or EIP-1271 for a contract wallet, via an X Layer RPC. */
export function makeSiweVerifier(rpcUrl: string): SiweVerifier {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async verify(args) {
      return client.verifySiweMessage({
        message: args.message,
        signature: args.signature,
        nonce: args.nonce,
        domain: args.domain,
      });
    },
  };
}
