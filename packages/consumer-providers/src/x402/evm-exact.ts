/**
 * x402 `exact` on an EVM rail — EIP-3009 `transferWithAuthorization`.
 *
 * This is the same scheme Untch already settles on X Layer, pointed outward. The three properties
 * that make it the right rail for a governed purchase are worth stating, because they are why the
 * Consumer Pack never issues an ERC-20 `approve`:
 *
 *   • The authorization names an EXACT value and an EXACT recipient. There is no allowance to
 *     over-grant and nothing left standing after the transfer.
 *   • It carries `validAfter` / `validBefore`, so a captured signature expires on its own.
 *   • It carries a random 32-byte `nonce`, so the same authorization cannot be replayed.
 *
 * The signer never broadcasts. It produces the `X-PAYMENT` header the provider's own facilitator
 * submits — which is what keeps Untch off the gas path on rails where it holds no native balance.
 */

import {
  formatMoney,
  normalizedError,
  ProviderError,
  type CaipChainId,
  type ConfirmedAsset,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
} from "@untch/consumer-core";
import type { AssetRef } from "@untch/consumer-core";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http as viemHttp,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { eip3009DomainFor, parseChallenge, selectPayment, type X402PaymentOption } from "./challenge";

/** The EIP-712 types for EIP-3009. Fixed by the standard; not provider-supplied. */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface EvmExactClientDeps {
  readonly chain: CaipChainId;
  readonly evmChainId: number;
  readonly privateKey: Hex | null;
  readonly rpcUrl: string | null;
  readonly clock?: () => number;
  /** Injected for tests: a deterministic 32-byte nonce source. */
  readonly nonceSource?: () => Uint8Array;
  /** Injected for tests: read a token balance without an RPC. */
  readonly balanceReader?: (asset: AssetRef, owner: string) => Promise<bigint>;
}

export class X402EvmExactClient implements RailClient {
  readonly chain: CaipChainId;
  private readonly evmChainId: number;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private readonly rpcUrl: string | null;
  private readonly clock: () => number;
  private readonly nonceSource: () => Uint8Array;
  private readonly balanceReader: ((asset: AssetRef, owner: string) => Promise<bigint>) | null;
  private publicClient: PublicClient | null = null;

  constructor(deps: EvmExactClientDeps) {
    this.chain = deps.chain;
    this.evmChainId = deps.evmChainId;
    this.account = deps.privateKey ? privateKeyToAccount(deps.privateKey) : null;
    this.rpcUrl = deps.rpcUrl;
    this.clock = deps.clock ?? Date.now;
    this.nonceSource = deps.nonceSource ?? (() => new Uint8Array(randomBytes(32)));
    this.balanceReader = deps.balanceReader ?? null;
  }

  address(): string {
    if (!this.account) {
      throw new Error(`no signing key configured for ${this.chain}`);
    }
    return this.account.address;
  }

  available(): boolean {
    return this.account !== null;
  }

  async balanceOf(asset: AssetRef): Promise<Money> {
    if (!this.account) {
      throw new ProviderError(
        normalizedError("TREASURY_INSUFFICIENT", `no signing key configured for ${this.chain}`),
      );
    }
    if (this.balanceReader) {
      return { amount: await this.balanceReader(asset, this.account.address), asset };
    }
    if (!this.rpcUrl || asset.address === null) {
      throw new ProviderError(
        normalizedError(
          "TREASURY_INSUFFICIENT",
          `cannot read the ${asset.symbol} balance on ${this.chain}: no RPC configured`,
        ),
      );
    }
    const client = this.client();
    const balance = await client.readContract({
      address: getAddress(asset.address) as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(this.account.address) as Address],
    });
    return { amount: balance, asset };
  }

  private client(): PublicClient {
    if (!this.publicClient) {
      if (!this.rpcUrl) throw new Error(`no RPC configured for ${this.chain}`);
      this.publicClient = createPublicClient({ transport: viemHttp(this.rpcUrl) });
    }
    return this.publicClient;
  }

  /**
   * Sign the exact authorization for one challenge and return the `X-PAYMENT` header.
   *
   * `txHash` is null on purpose: on this scheme WE do not broadcast. The provider's facilitator
   * submits the authorization and reports the hash back on the paid retry's `PAYMENT-RESPONSE`. A
   * client that invented a hash here would be putting a guess into a receipt.
   */
  async pay(req: PaymentRequest): Promise<PaymentResult> {
    if (!this.account) {
      throw new ProviderError(
        normalizedError("TREASURY_INSUFFICIENT", `no signing key configured for ${this.chain}`),
      );
    }

    const challenge = parseChallenge(req.challenge);
    /**
     * Re-select through the SAME `selectPayment` the orchestrator used, rather than scanning
     * `accepts[]` for the first entry that happens to match amount + recipient.
     *
     * An independent re-find is exploitable: a provider can offer a decoy option carrying the same
     * amount and payTo but a DIFFERENT asset or `extra` domain, place it earlier in the array, and
     * have the signer bind the authorization to the decoy's terms while every upstream allowlist
     * check passed against the entry `selectPayment` actually chose. Running one selector means
     * there is exactly one answer to "which option is being paid".
     */
    const selected = selectPayment(challenge, {
      signableChains: new Set([this.chain]),
      ceilingFor: () => req.amount,
      allowedRecipients: [req.recipient],
    });
    const option = selected.option;
    if (option.amount !== req.amount.amount) {
      // The capability already checked amount/recipient against what was AUTHORISED. This checks
      // them against what the provider is actually ASKING FOR, right now, in the challenge being
      // paid. Both must agree, or the two sides of the payment do not describe the same purchase.
      throw new ProviderError(
        normalizedError(
          "PAYMENT_BINDING_MISMATCH",
          `the challenge does not offer ${formatMoney(req.amount)} to the authorised recipient on ` +
            `${this.chain} — refusing to sign a payment the provider did not ask for`,
        ),
      );
    }
    if (req.amount.asset.address === null) {
      throw new ProviderError(
        normalizedError("PAYMENT_CHALLENGE_UNACCEPTABLE", "a native coin cannot carry an EIP-3009 authorization"),
      );
    }

    const asset = req.amount.asset as ConfirmedAsset;
    const domainParams = eip3009DomainFor(option, asset);

    const nowSec = Math.floor(this.clock() / 1000);
    // `now - 5` rather than 0, matching @okxweb3/x402-evm's own createEIP3009Payload. The five
    // seconds of slack absorb clock skew between us and the settling node: USDC requires
    // `block.timestamp > validAfter`, and a validAfter equal to now can lose that race on a fast
    // block. Zero would also work, but there is no reason to diverge from the reference client on a
    // field a facilitator may well compare.
    const validAfter = BigInt(Math.max(0, nowSec - 5));
    const validBefore = BigInt(nowSec + Math.max(60, option.maxTimeoutSeconds));
    const nonce = `0x${Buffer.from(this.nonceSource()).toString("hex")}` as Hex;

    const authorization = {
      from: getAddress(this.account.address) as Address,
      to: getAddress(option.payTo) as Address,
      value: req.amount.amount,
      validAfter,
      validBefore,
      nonce,
    };

    const signature = await this.account.signTypedData({
      domain: {
        name: domainParams.name,
        version: domainParams.version,
        chainId: this.evmChainId,
        verifyingContract: getAddress(asset.address) as Address,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: authorization,
    });

    /**
     * The x402 v2 `PaymentPayload` envelope, byte-for-byte the shape the reference client builds.
     *
     * Verified against the INSTALLED packages rather than against a spec summary:
     *   • `@okxweb3/x402-core`'s type      — { x402Version, resource?, accepted, payload, extensions? }
     *   • its client's assembly            — payload + extensions + resource + accepted
     *   • `@okxweb3/x402-evm`'s eip3009    — payload is exactly { authorization, signature }
     *
     * `resource` and `extensions` are echoed back from the challenge because the reference client
     * echoes them: a facilitator is entitled to bind a payment to the resource it was issued for,
     * and omitting the field would leave that binding unsatisfiable. There are deliberately NO
     * top-level `scheme`/`network` keys — they live inside `accepted`, and a strict validator has
     * every right to reject unknown members.
     */
    const payload = {
      x402Version: challenge.x402Version,
      payload: {
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
        signature,
      },
      ...(Object.keys(challenge.extensions).length > 0 ? { extensions: challenge.extensions } : {}),
      ...(challenge.resource.url === "" ? {} : { resource: challenge.resource }),
      // The SELECTED requirements, verbatim. The facilitator matches its own challenge against this.
      accepted: {
        scheme: option.scheme,
        network: option.network,
        asset: option.asset,
        amount: option.amount.toString(),
        payTo: option.payTo,
        maxTimeoutSeconds: option.maxTimeoutSeconds,
        extra: option.extra,
      },
    };

    return {
      paymentHeader: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      /**
       * x402 v2 names this header `PAYMENT-SIGNATURE`. `X-PAYMENT` is the v1 name.
       *
       * Confirmed three ways rather than assumed: @okxweb3/x402-fetch emits PAYMENT-SIGNATURE;
       * Untch's own first settled payment (internal/day0/D0.1-evidence/paid-call-transcript.json)
       * shows the PAYMENT-REQUIRED / PAYMENT-RESPONSE pair; and a live probe against
       * stabledomains.dev on 2026-07-27 reached signature verification under BOTH names, so the
       * provider's facilitator accepts either. `aliasHeaderNames` keeps the v1 name on the wire for
       * facilitators that only read it — sending both costs nothing and removes a whole class of
       * "the payment was ignored" failure.
       */
      headerName: "PAYMENT-SIGNATURE",
      aliasHeaderNames: ["X-PAYMENT"],
      txHash: null,
      amount: req.amount,
      recipient: option.payTo,
      chain: this.chain,
    };
  }
}

/** Exposed for tests: the exact typed-data structure a signature covers. */
export function buildAuthorizationTypedData(args: {
  readonly from: string;
  readonly option: X402PaymentOption;
  readonly asset: ConfirmedAsset;
  readonly evmChainId: number;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
}): Record<string, unknown> {
  const domainParams = eip3009DomainFor(args.option, args.asset);
  return {
    domain: {
      name: domainParams.name,
      version: domainParams.version,
      chainId: args.evmChainId,
      verifyingContract: getAddress(args.asset.address) as Address,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(args.from) as Address,
      to: getAddress(args.option.payTo) as Address,
      value: args.value,
      validAfter: args.validAfter,
      validBefore: args.validBefore,
      nonce: args.nonce,
    },
  };
}
