/**
 * x402 `exact` on Solana — a sponsored SPL transfer.
 *
 * STATUS: executable. The payload is built by the OFFICIAL x402 client (`x402@1.2.0`, `exact.svm`),
 * never by anything hand-rolled here.
 *
 * That distinction is this file's whole history. The previous version refused to pay, and the
 * refusal was right at the time: the challenges told us the network, the mint, the payTo and the
 * sponsoring feePayer, but not the serialization, and four details were coin flips — legacy versus
 * versioned transaction, who supplies the blockhash, `transfer` versus `transferChecked`, and
 * whether an associated-token-account creation instruction belongs in the message. A
 * plausible-but-wrong payload against a real merchant is a failed purchase, so the rail reported
 * PROTOCOL_NOT_EXECUTABLE rather than guess.
 *
 * Reading the reference implementation answered all four, and this file now DEFERS to it rather
 * than reproducing its answers, because a copy drifts and a dependency does not:
 *
 *   • a VERSIONED (v0) transaction message
 *   • the CLIENT supplies the blockhash, from its own RPC
 *   • `transferChecked`, with decimals read from the mint account
 *   • no ATA creation, so the destination token account must already exist
 *   • fee payer is the SPONSOR from `extra.feePayer`, so the treasury needs no SOL for the transfer
 *   • the transaction is PARTIALLY signed: this wallet signs as the transfer authority, and the
 *     sponsor countersigns and submits
 *
 * WHAT THIS FILE STILL OWNS
 *
 * Everything about whether a payment is ALLOWED. The reference client is a serializer: hand it a
 * recipient, a mint and an amount and it will faithfully build a payment for them. It is not a
 * control and was never meant to be one. So every check below runs BEFORE the builder is reached,
 * and each REFUSES rather than clamps. A clamped payment is still a payment, and a caller who asked
 * to send the wrong amount to the wrong place should be told no rather than quietly corrected.
 *
 * THE NETWORK STRING
 *
 * The reference writes `network: "solana"` into the payload. Purch's challenge declares
 * `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. A facilitator compares the payload against its own
 * challenge, so this rail echoes the PROVIDER's exact string back. That is a judgement call, it is
 * recorded as one, and there is deliberately no fallback that tries the other spelling on failure:
 * a silent retry with different bytes would make the answer unknowable.
 */

import {
  normalizedError,
  ProviderError,
  SOLANA_USDC_MINT,
  decodeBase58,
  encodeBase58,
  type AssetRef,
  type CaipChainId,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
} from "@untch/consumer-core";
import {
  buildV2SvmCredential,
  decodeSvmTransfer,
  type DecodedTransfer,
  type V2Credential,
  type V2CredentialInput,
} from "./v2-svm-client";

/** Solana mainnet's genesis hash. CAIP-2 truncates it to 32 characters. */
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/**
 * The recipients Untch will pay on Solana, and who each belongs to.
 *
 * Keyed by ADDRESS rather than by provider name, because the name is ours and the address is the
 * thing that actually receives money. Every entry was read from a live challenge. A challenge naming
 * anything else is refused before the signer is reached.
 */
export const SOLANA_RECIPIENT_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2": "purch",
  HvBMG7ezcwDssxXP7DPJJsveyDnvUm2wNySBR5WF2XEY: "stableemail",
});

/**
 * The minimum SOL a sponsored treasury still needs, in lamports.
 *
 * Sponsored transfers cost this wallet no fee, so the reserve is not for gas. It is for the one
 * thing a sponsor cannot cover: rent-exemption on the treasury's own token account, about 0.00204
 * SOL. Falling under it means the account can be reclaimed, which loses the float rather than a
 * transaction.
 */
export const SOLANA_MIN_LAMPORTS = 2_100_000n;

export interface SolanaExactClientDeps {
  readonly chain: CaipChainId;
  /** Base58 secret key. Never logged, never serialized. */
  readonly secretKey: string | null;
  readonly rpcUrl: string | null;
  /** Mints this rail may settle in. Defaults to the canonical USDC mint alone. */
  readonly mintAllowlist?: readonly string[];
  /** Recipients this rail may pay. Defaults to the module allowlist. */
  readonly recipientAllowlist?: readonly string[];
  /**
   * Whether spending is armed. FALSE by default, and deliberately independent of whether a key
   * exists: credentials existing is not permission, which is the same rule the flag layer states for
   * every other rail.
   */
  readonly executionEnabled?: boolean;
  /** Injected for tests. */
  readonly balanceReader?: (asset: AssetRef, owner: string) => Promise<bigint>;
  readonly lamportReader?: (owner: string) => Promise<bigint>;
  readonly addressResolver?: (secretKey: string) => string;
  /** Injected for tests. Defaults to the official x402 v2 SVM client. */
  readonly credentialBuilder?: (input: V2CredentialInput) => Promise<V2Credential>;
  /** Injected for tests. Defaults to decoding the real wire transaction. */
  readonly transferDecoder?: (wireTransaction: string) => Promise<DecodedTransfer>;
  readonly clock?: () => number;
}

export interface SolanaPayloadInput {
  readonly secretKey: string;
  readonly rpcUrl: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly feePayer: string;
  readonly resource: string;
  readonly maxTimeoutSeconds: number;
  /** The network string EXACTLY as the provider declared it. */
  readonly declaredNetwork: string;
}

export interface SolanaPayload {
  readonly scheme: string;
  readonly network: string;
  readonly x402Version: number;
  readonly payload: { readonly transaction: string };
}

/** Read one string field out of an untrusted challenge without trusting its shape. */
function field(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Read an atomic amount from EITHER challenge shape.
 *
 * A rail can be handed the challenge in two forms, and this cost a real live run before it was
 * handled. The transport passes the NORMALIZED `X402Challenge`, whose options carry `amount` as a
 * bigint, while a raw decoded challenge carries it as a decimal string. A string-only reader saw the
 * bigint as absent and refused a perfectly good challenge with "amount (absent) is not an atomic
 * integer".
 *
 * That refusal was the right failure. It stopped before signing, cost nothing, and named a field. But
 * the reason it fired was a bug on our side rather than anything wrong with the merchant, and a
 * guard that cannot tell those apart is a guard that gets ignored.
 *
 * A float is still refused. A provider sending 19.99 where an atomic amount belongs has either
 * mis-specified its API or is quoting display units, and guessing which puts a factor of a million
 * into a payment.
 */
function atomicField(o: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return Number.isSafeInteger(v) ? String(v) : null;
    if (typeof v === "string" && /^\d+$/.test(v)) return v;
  }
  return null;
}

/**
 * Find the Solana option inside whichever challenge shape arrived.
 *
 * The `PaymentRequest.challenge` handed to a rail is the WHOLE decoded challenge, not the option the
 * selection layer picked, so the option is found again here. Finding it rather than trusting a
 * caller's summary is the point: every check below is against the merchant's own numbers, and a
 * summary is a second opinion about what the merchant asked for.
 */
export function selectSolanaOption(
  challenge: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const accepts = challenge.accepts;
  if (!Array.isArray(accepts)) return null;
  for (const raw of accepts) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.network === "string" && o.network.startsWith("solana:")) return o;
  }
  return null;
}

export class X402SolanaExactClient implements RailClient {
  readonly chain: CaipChainId;
  private readonly secretKey: string | null;
  private readonly rpcUrl: string | null;
  private readonly mintAllowlist: readonly string[];
  private readonly recipientAllowlist: readonly string[];
  private readonly executionEnabled: boolean;
  private readonly balanceReader: ((asset: AssetRef, owner: string) => Promise<bigint>) | null;
  private readonly lamportReader: ((owner: string) => Promise<bigint>) | null;
  private readonly addressResolver: ((secretKey: string) => string) | null;
  private readonly credentialBuilder: ((input: V2CredentialInput) => Promise<V2Credential>) | null;
  private readonly transferDecoder: ((wireTransaction: string) => Promise<DecodedTransfer>) | null;
  private readonly clock: () => number;
  private cachedAddress: string | null = null;

  constructor(deps: SolanaExactClientDeps) {
    this.chain = deps.chain;
    this.secretKey = deps.secretKey;
    this.rpcUrl = deps.rpcUrl;
    this.mintAllowlist = deps.mintAllowlist ?? [SOLANA_USDC_MINT];
    this.recipientAllowlist = deps.recipientAllowlist ?? Object.keys(SOLANA_RECIPIENT_ALLOWLIST);
    this.executionEnabled = deps.executionEnabled ?? false;
    this.balanceReader = deps.balanceReader ?? null;
    this.lamportReader = deps.lamportReader ?? null;
    this.addressResolver = deps.addressResolver ?? null;
    this.credentialBuilder = deps.credentialBuilder ?? null;
    this.transferDecoder = deps.transferDecoder ?? null;
    this.clock = deps.clock ?? Date.now;
  }

  /**
   * The public address, taken from the last 32 bytes of the 64-byte keypair.
   *
   * A Solana keypair is a 32-byte seed followed by its own public key, so the address is already
   * present in the secret and needs no cryptography to extract. Doing it here rather than through a
   * signing library means treasury monitoring can name the wallet on an instance that cannot spend.
   */
  address(): string {
    if (!this.secretKey) throw new Error(`no Solana signing key configured for ${this.chain}`);
    if (this.cachedAddress) return this.cachedAddress;
    if (this.addressResolver) {
      this.cachedAddress = this.addressResolver(this.secretKey);
      return this.cachedAddress;
    }
    const bytes = decodeBase58(this.secretKey.trim());
    if (bytes === null || bytes.length !== 64) {
      throw new Error("the Solana secret key is not a base58 64-byte keypair");
    }
    this.cachedAddress = encodeBase58(bytes.subarray(32));
    return this.cachedAddress;
  }

  /**
   * Available means a key exists, an RPC exists, AND an operator armed spending.
   *
   * The last clause carries the weight. `available()` decides whether the treasury router will mint
   * a capability for this rail, so a rail that is merely CAPABLE must not be selectable. Without it
   * an intent reaches PROVIDER_PAYMENT_PENDING before anyone has decided it should, and that is the
   * one transition that costs a manual review.
   */
  available(): boolean {
    return this.executionEnabled && this.secretKey !== null && this.rpcUrl !== null;
  }

  /** Whether monitoring can read this float, independent of whether it may spend from it. */
  readable(): boolean {
    return this.secretKey !== null && (this.rpcUrl !== null || this.balanceReader !== null);
  }

  async balanceOf(asset: AssetRef): Promise<Money> {
    if (!this.secretKey) {
      throw new ProviderError(
        normalizedError("TREASURY_INSUFFICIENT", `no Solana signing key configured for ${this.chain}`),
      );
    }
    if (this.balanceReader) {
      return { amount: await this.balanceReader(asset, this.address()), asset };
    }
    if (!this.rpcUrl) {
      throw new ProviderError(
        normalizedError(
          "TREASURY_INSUFFICIENT",
          `cannot read the ${asset.symbol} balance on ${this.chain}: set CONSUMER_SOLANA_RPC_URL`,
        ),
      );
    }
    return { amount: await readSplBalance(this.rpcUrl, this.address(), asset), asset };
  }

  /** Native SOL, in lamports. Used for the rent-reserve check, not for gas. */
  async lamports(): Promise<bigint> {
    if (this.lamportReader) return this.lamportReader(this.address());
    if (!this.rpcUrl) {
      throw new ProviderError(
        normalizedError("TREASURY_INSUFFICIENT", "CONSUMER_SOLANA_RPC_URL is not set"),
      );
    }
    return readLamports(this.rpcUrl, this.address());
  }

  /**
   * Pay one x402 challenge.
   *
   * The ordering is the control. Every refusal happens before the payload builder is reached, so a
   * rejected payment never produces a signature at all. That matters more here than on an EVM rail:
   * the signed artifact is a transaction a THIRD PARTY submits, so a signature that exists is a
   * signature somebody else can broadcast at a time of their choosing.
   */
  async pay(req: PaymentRequest): Promise<PaymentResult> {
    if (!this.executionEnabled) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_NOT_EXECUTABLE",
          "Solana settlement is not armed on this instance. Set CONSUMER_SOLANA_EXECUTION_ENABLED=1. " +
            "A key existing is not permission.",
        ),
      );
    }
    if (!this.secretKey) {
      throw new ProviderError(
        normalizedError("TREASURY_INSUFFICIENT", `no Solana signing key configured for ${this.chain}`),
      );
    }
    if (!this.rpcUrl) {
      throw new ProviderError(
        normalizedError("TREASURY_INSUFFICIENT", "CONSUMER_SOLANA_RPC_URL is not set"),
      );
    }

    const option = selectSolanaOption(req.challenge);
    if (!option) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          "the challenge carries no Solana option, so this rail must not answer it",
        ),
      );
    }

    // ── the merchant's own numbers, never a caller's summary of them ────────
    const network = field(option, "network");
    const scheme = field(option, "scheme");
    const amount = atomicField(option, "amount", "maxAmountRequired");
    const asset = field(option, "asset");
    const payTo = field(option, "payTo");
    const extra = (option.extra ?? {}) as Record<string, unknown>;
    const feePayer = typeof extra.feePayer === "string" ? extra.feePayer : null;

    if (network === null || !isSolanaMainnet(network)) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `the challenge is on ${network ?? "an unnamed network"}, which is not Solana mainnet ` +
            `(${SOLANA_MAINNET_CAIP2})`,
        ),
      );
    }
    if (scheme !== "exact") {
      throw new ProviderError(
        normalizedError("PAYMENT_CHALLENGE_UNACCEPTABLE", `scheme '${scheme ?? "(absent)"}' is not 'exact'`),
      );
    }
    if (asset === null || !this.mintAllowlist.includes(asset)) {
      // On Solana a token's identity IS its mint. Anything can call itself USDC in its metadata, so
      // the allowlist is by mint and a near-miss is refused rather than warned about.
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `mint ${asset ?? "(absent)"} is not on the settlement allowlist`,
        ),
      );
    }
    if (payTo === null || !this.recipientAllowlist.includes(payTo)) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `recipient ${payTo ?? "(absent)"} is not on the Solana recipient allowlist`,
        ),
      );
    }
    if (feePayer === null) {
      // Without a sponsor the treasury would pay the network fee itself, which is a different
      // transaction with different SOL requirements. Refuse rather than silently absorb the cost.
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          "the challenge names no extra.feePayer. This rail answers SPONSORED challenges only.",
        ),
      );
    }
    if (amount === null || !/^\d+$/.test(amount)) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `amount ${amount ?? "(absent)"} is not an atomic integer`,
        ),
      );
    }

    /**
     * The authorised figure is checked against the CHALLENGE's, not accepted from either alone.
     *
     * `req.amount` is what the selection layer decided to pay; `amount` is what the merchant asked
     * for. They should be identical, and if they are not then something between the two altered a
     * number. Paying either one would be wrong, so the mismatch itself is the refusal.
     */
    if (BigInt(amount) !== req.amount.amount) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `the challenge asks ${amount} but this payment was authorised for ${req.amount.amount}. ` +
            "Refusing rather than paying either figure.",
        ),
      );
    }
    if (payTo !== req.recipient) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `the challenge pays ${payTo} but this payment was authorised for ${req.recipient}`,
        ),
      );
    }

    // ── staleness ───────────────────────────────────────────────────────────
    // A Solana blockhash lives about 60 seconds, so a challenge older than its own stated window
    // produces a transaction that expires before the sponsor can land it. Refusing here turns a
    // confusing provider-side failure into a clear local one.
    const issuedAt = field(option, "issuedAt") ?? field(req.challenge as Record<string, unknown>, "issuedAt");
    const maxTimeoutSeconds =
      typeof option.maxTimeoutSeconds === "number" ? option.maxTimeoutSeconds : 300;
    if (issuedAt !== null) {
      const age = this.clock() - Date.parse(issuedAt);
      if (Number.isFinite(age) && age > maxTimeoutSeconds * 1000) {
        throw new ProviderError(
          normalizedError(
            "QUOTE_EXPIRED",
            `the challenge was issued ${Math.round(age / 1000)}s ago, past its ${maxTimeoutSeconds}s ` +
              "window. Re-fetch it rather than signing against a dead blockhash.",
          ),
        );
      }
    }

    // ── float ───────────────────────────────────────────────────────────────
    const lamports = await this.lamports().catch(() => null);
    if (lamports !== null && lamports < SOLANA_MIN_LAMPORTS) {
      throw new ProviderError(
        normalizedError(
          "TREASURY_INSUFFICIENT",
          `the Solana treasury holds ${lamports} lamports, under the ${SOLANA_MIN_LAMPORTS} rent ` +
            "reserve. Sponsored transfers need no gas, but the token account still needs rent.",
        ),
      );
    }

    /**
     * Construction is DELEGATED. Untch no longer builds the v2 envelope.
     *
     * The hand-built `base64(JSON({scheme, network, x402Version, payload}))` is a v1 shape, and
     * Purch rejected it under the correct v2 header just as firmly as under the wrong ones. The two
     * protocols are not a header apart, so the envelope is now produced by the official client and
     * this file stops having an opinion about its bytes.
     *
     * Every guard above has already run. Nothing below can widen the amount, the recipient, the mint
     * or the network, and the check after construction is what enforces that rather than trusting it.
     */
    const built = this.credentialBuilder
      ? await this.credentialBuilder({
          rawChallenge: req.challenge,
          secretKey: this.secretKey,
          rpcUrl: this.rpcUrl,
          network,
        })
      : await buildV2SvmCredential({
          rawChallenge: req.challenge,
          secretKey: this.secretKey,
          rpcUrl: this.rpcUrl,
          network,
        });

    /**
     * Exactly one payment header leaves this rail.
     *
     * The official client returns a map, and a map is an invitation to send whatever it contains.
     * Two payment headers on one request lets a verifier read the one we did not intend, so the
     * contents are asserted rather than forwarded.
     */
    const names = Object.keys(built.headers);
    const signature = built.headers["PAYMENT-SIGNATURE"] ?? built.headers["payment-signature"];
    if (typeof signature !== "string" || signature.length === 0) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_MALFORMED_RESPONSE",
          `the official x402 client produced no PAYMENT-SIGNATURE header (got: ${names.join(", ") || "none"})`,
        ),
      );
    }
    if (names.some((n) => /^x-payment$/i.test(n))) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          "the client produced an X-PAYMENT header for a v2 challenge. Refusing to mix protocol versions.",
        ),
      );
    }

    // ── decode the bytes and check they describe what was authorised ────────
    //
    // The official client is trusted to be protocol-correct and NOT trusted about amounts. It
    // faithfully encodes whatever requirements it is handed, so a wrong requirement would produce a
    // wrong transfer just as faithfully. Reading the amount back out of the bytes is the only check
    // that cannot be fooled by a bad input.
    const decoded = await (this.transferDecoder ?? decodeSvmTransfer)(built.wireTransaction);

    if (decoded.amount !== null && decoded.amount !== BigInt(amount)) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `the built transaction transfers ${decoded.amount} but the challenge asked ${amount}. ` +
            "Refusing to send it.",
        ),
      );
    }
    if (decoded.mint !== null && decoded.mint !== asset) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `the built transaction moves ${decoded.mint}, not the validated mint ${asset}`,
        ),
      );
    }
    if (decoded.feePayer !== null && decoded.feePayer !== feePayer) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `the built transaction names ${decoded.feePayer} as fee payer, not the sponsor ${feePayer}. ` +
            "A transaction this treasury pays for is a different transaction.",
        ),
      );
    }
    if (!decoded.hasBlockhash) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          "the built transaction carries no blockhash, so it has no lifetime and cannot be landed",
        ),
      );
    }
    if (built.declared.x402Version !== null && built.declared.x402Version !== 2) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `the client declared x402Version ${built.declared.x402Version} for a v2 challenge`,
        ),
      );
    }

    return {
      // The credential is OPAQUE. It is forwarded exactly as the official client encoded it, and is
      // never re-wrapped: re-encoding a credential is how the last envelope went wrong.
      paymentHeader: signature,
      headerName: "PAYMENT-SIGNATURE",
      // The SPONSOR submits, so this wallet never learns the signature at signing time. Inventing
      // one would put a hash in the ledger that no explorer can resolve. The facilitator reports the
      // real one in PAYMENT-RESPONSE and the transport reads it from there.
      txHash: null,
      amount: req.amount,
      recipient: req.recipient,
      chain: this.chain,
    };
  }
}

/**
 * Accept the CAIP-2 id whether it carries the truncated or the full genesis hash.
 *
 * CAIP-2 caps a reference at 32 characters, so Solana mainnet is canonically
 * `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. Some providers send the untruncated 44-character
 * genesis hash instead. Both name the same cluster, and refusing one of them would reject a correct
 * challenge over a formatting choice. Anything else, including devnet and testnet, is refused.
 */
export function isSolanaMainnet(network: string): boolean {
  if (!network.startsWith("solana:")) return false;
  const reference = network.slice("solana:".length);
  return SOLANA_MAINNET_GENESIS.startsWith(reference) && reference.length >= 32;
}

/**
 * The default payload builder: the OFFICIAL x402 SVM client, imported lazily.
 *
 * Lazily because it pulls in the Solana toolchain, and an instance with no Solana rail should not
 * pay that import cost at boot. The `network` handed to the reference is the plain string its RPC
 * helper understands; the network written into the returned PAYLOAD is put back to exactly what the
 * provider declared.
 */
async function defaultPayloadBuilder(input: SolanaPayloadInput): Promise<SolanaPayload> {
  const [{ createKeyPairSignerFromBytes }, { exact }] = await Promise.all([
    import("@solana/kit"),
    import("x402/schemes"),
  ]);

  const bytes = decodeBase58(input.secretKey.trim());
  if (bytes === null || bytes.length !== 64) {
    throw new ProviderError(
      normalizedError("TREASURY_INSUFFICIENT", "the Solana secret key is not a base58 64-byte keypair"),
    );
  }
  const signer = await createKeyPairSignerFromBytes(bytes);

  let built: { payload: { transaction: string } };
  try {
    built = (await exact.svm.createAndSignPayment(
      signer,
      2,
      {
        scheme: "exact",
        network: "solana",
        maxAmountRequired: input.amount,
        asset: input.asset,
        payTo: input.payTo,
        resource: input.resource,
        description: "",
        mimeType: "application/json",
        maxTimeoutSeconds: input.maxTimeoutSeconds,
        extra: { feePayer: input.feePayer },
      } as never,
      { svmConfig: { rpcUrl: input.rpcUrl } },
    )) as { payload: { transaction: string } };
  } catch (err) {
    // Building failed BEFORE anything was submitted, so nothing was spent and nothing is ambiguous.
    // Saying so explicitly matters: the caller's next question is always "did money move".
    throw new ProviderError(
      normalizedError(
        "PAYMENT_FAILED",
        `could not build the Solana payment: ${(err as Error).message}. Nothing was signed or sent.`,
        { paymentSettled: false },
      ),
    );
  }

  return {
    scheme: "exact",
    network: input.declaredNetwork,
    x402Version: 2,
    payload: { transaction: built.payload.transaction },
  };
}

async function solanaRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new ProviderError(
      normalizedError("TREASURY_INSUFFICIENT", `Solana RPC returned ${res.status} for ${method}`),
    );
  }
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) {
    throw new ProviderError(
      normalizedError("TREASURY_INSUFFICIENT", `Solana RPC error on ${method}: ${body.error.message ?? "unknown"}`),
    );
  }
  return body.result;
}

/**
 * Read an SPL token balance over plain JSON-RPC.
 *
 * No dependency, because reading a balance is the one thing treasury monitoring must do on an
 * instance that cannot spend. A missing token account reads as ZERO rather than as an error: a
 * treasury that has never been funded genuinely holds nothing, and reporting that as a failure would
 * make an unfunded rail indistinguishable from a broken one.
 */
async function readSplBalance(rpcUrl: string, owner: string, asset: AssetRef): Promise<bigint> {
  const mint = asset.address ?? SOLANA_USDC_MINT;

  try {
    const result = (await solanaRpc(rpcUrl, "getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed" },
    ])) as { value?: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] };

    let total = 0n;
    for (const a of result.value ?? []) total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
    return total;
  } catch {
    /**
     * Fall back to reading the derived associated token account directly.
     *
     * `getTokenAccountsByOwner` scans by owner and is one of the first methods a public RPC sheds
     * under load. `api.mainnet-beta.solana.com` answers it with a flat 503 while serving
     * `getTokenAccountBalance` on a known account without complaint, and that asymmetry stopped a
     * live run at the treasury check before it reached a single guard.
     *
     * Deriving the ATA and asking for one account is both cheaper and more precise. A treasury with
     * no token account yet reads as ZERO rather than as an error, because an unfunded rail and a
     * broken one should not look the same.
     *
     * This is a fallback, not the primary path. A production deployment should set
     * CONSUMER_SOLANA_RPC_URL to a real provider rather than lean on a public endpoint's mood.
     */
    const [{ findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS }] = await Promise.all([
      import("@solana-program/token"),
    ]);
    const [ata] = await findAssociatedTokenPda({
      mint: mint as never,
      owner: owner as never,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    try {
      const balance = (await solanaRpc(rpcUrl, "getTokenAccountBalance", [ata])) as {
        value?: { amount?: string };
      };
      return BigInt(balance.value?.amount ?? "0");
    } catch {
      return 0n;
    }
  }
}

async function readLamports(rpcUrl: string, owner: string): Promise<bigint> {
  const result = (await solanaRpc(rpcUrl, "getBalance", [owner])) as { value?: number };
  return BigInt(result.value ?? 0);
}

/**
 * Confirm a settlement the sponsor submitted.
 *
 * Used after a paid retry, when the facilitator reported a signature. It answers one question, and
 * refuses to answer more than one: did THIS signature land, and did it succeed. It does not decide
 * whether to retry, because that decision needs the provider's state as well as the chain's.
 */
export async function confirmSolanaSettlement(
  rpcUrl: string,
  signature: string,
): Promise<{ readonly found: boolean; readonly succeeded: boolean; readonly slot: number | null }> {
  const result = (await solanaRpc(rpcUrl, "getTransaction", [
    signature,
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  ])) as { slot?: number; meta?: { err?: unknown } } | null;

  if (result === null) return { found: false, succeeded: false, slot: null };
  return {
    found: true,
    succeeded: result.meta?.err === null || result.meta?.err === undefined,
    slot: typeof result.slot === "number" ? result.slot : null,
  };
}
