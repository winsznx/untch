/**
 * The x402 **v2** SVM payment client. A thin, deliberate boundary around the official packages.
 *
 * WHY THIS IS SEPARATE FROM THE V1 PATH
 *
 * Untch previously built one envelope by hand and sent it under whichever header seemed right. That
 * worked on EVM, where the v1 shape is what facilitators read, and failed silently on Solana against
 * a v2 provider. The two protocols are not a header apart. Purch accepted a 3012-byte opaque
 * credential from its own client and rejected Untch's 916-byte `base64(JSON({scheme, network,
 * x402Version, payload}))` under the same `PAYMENT-SIGNATURE` header.
 *
 * So there is no shared builder any more. v1 keeps its envelope, v2 delegates, and neither can be
 * reached from the other's challenge. A version mismatch is a refusal rather than a translation,
 * because a translation is exactly the kind of quiet accommodation that produced a payload nobody
 * could explain.
 *
 * WHAT THIS MODULE DOES NOT DECIDE
 *
 * Anything about whether a payment is allowed. It is reached only after `X402SolanaExactClient` has
 * validated the cluster, the mint, the recipient, the sponsor, the amount and the challenge's age.
 * Its whole job is to turn an already-authorised intention into protocol-correct bytes, and to hand
 * back enough detail that the caller can check those bytes describe what it authorised.
 */

import { normalizedError, ProviderError } from "@untch/consumer-core";

export interface V2CredentialInput {
  /** The RAW decoded challenge, exactly as the provider sent it. Never a normalised copy. */
  readonly rawChallenge: Readonly<Record<string, unknown>>;
  /** Base58 secret key. Never logged, never returned. */
  readonly secretKey: string;
  readonly rpcUrl: string;
  /** The option the caller validated, used to pin the client's selection to the same one. */
  readonly network: string;
}

export interface V2Credential {
  /** Header name to value. The official client decides both. */
  readonly headers: Readonly<Record<string, string>>;
  /** The base64 wire transaction, pulled out so the caller can decode and re-verify it. */
  readonly wireTransaction: string;
  /** What the payload declares, for the caller to compare against the challenge. */
  readonly declared: {
    readonly scheme: string | null;
    readonly network: string | null;
    readonly x402Version: number | null;
  };
}

/**
 * Decode a base58 secret without pulling in a signing library for the check.
 * Duplicated from consumer-core deliberately: this module must not depend on the domain package for
 * something this small, and the two implementations are asserted equal in tests.
 */
function decodeBase58Local(value: string): Uint8Array | null {
  const AB = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (value === "") return null;
  const bytes: number[] = [0];
  for (const ch of value) {
    const idx = AB.indexOf(ch);
    if (idx < 0) return null;
    let carry = idx;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of value) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Build one x402 v2 SVM credential.
 *
 * Every object here comes from the official packages, and the three calls mirror what
 * `wrapFetchWithPayment` does internally: parse the challenge, create the payload, encode the
 * header. Doing it in three steps rather than through the wrapper is what lets Untch inspect the
 * transaction before it is sent, which a wrapper that owns the fetch cannot.
 */
export async function buildV2SvmCredential(input: V2CredentialInput): Promise<V2Credential> {
  const [{ createKeyPairSignerFromBytes }, svm, fetchExt] = await Promise.all([
    import("@solana/kit"),
    import("@x402/svm"),
    import("@x402/fetch"),
  ]);

  const bytes = decodeBase58Local(input.secretKey.trim());
  if (bytes === null || bytes.length !== 64) {
    throw new ProviderError(
      normalizedError("TREASURY_INSUFFICIENT", "the Solana secret key is not a base58 64-byte keypair"),
    );
  }
  const signer = await createKeyPairSignerFromBytes(bytes);

  /**
   * The selector is pinned to the option the CALLER validated.
   *
   * Without this the client is free to pick any entry in `accepts`, and the entry it picks might not
   * be the one whose mint, recipient and amount were just checked. Pinning by network means a
   * provider adding a second rail cannot silently redirect an authorised payment onto it.
   */
  const client = new fetchExt.x402Client(
    (_version: number, requirements: { network?: string }[]) => {
      const pinned = requirements.find((r) => r.network === input.network);
      if (!pinned) {
        throw new ProviderError(
          normalizedError(
            "PAYMENT_CHALLENGE_UNACCEPTABLE",
            `the validated option for ${input.network} is absent from the requirements the client parsed`,
          ),
        );
      }
      return pinned as never;
    },
  );
  client.register(input.network as never, new svm.ExactSvmScheme(signer, { rpcUrl: input.rpcUrl }) as never);

  const httpClient = new fetchExt.x402HTTPClient(client);

  /**
   * Re-serialise the challenge into WIRE form before the official parser sees it.
   *
   * Untch's transport hands rails the NORMALISED challenge, whose amounts are bigints. The official
   * client expects the shape the provider actually sent, where an amount is a decimal string, and a
   * bare JSON.stringify over a bigint throws outright. That threw a live run at the construction
   * step, which cost nothing and was still the wrong reason to stop.
   *
   * Converting rather than stripping matters: the client validates the payload against these
   * requirements, so a field dropped here becomes a mismatch there.
   */
  const wireChallenge = JSON.stringify(input.rawChallenge, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const encoded = Buffer.from(wireChallenge, "utf8").toString("base64");
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name: string) => (name.toLowerCase() === "payment-required" ? encoded : null),
    undefined,
  );

  const payload = await client.createPaymentPayload(paymentRequired as never);
  const headers = httpClient.encodePaymentSignatureHeader(payload as never) as Record<string, string>;

  const p = payload as { scheme?: string; network?: string; x402Version?: number; payload?: { transaction?: string } };
  const wireTransaction = p.payload?.transaction;
  if (typeof wireTransaction !== "string" || wireTransaction.length === 0) {
    throw new ProviderError(
      normalizedError(
        "PROVIDER_MALFORMED_RESPONSE",
        "the official x402 client produced no wire transaction. Refusing to send a credential whose " +
          "contents cannot be checked.",
      ),
    );
  }

  return {
    headers,
    wireTransaction,
    declared: {
      scheme: typeof p.scheme === "string" ? p.scheme : null,
      network: typeof p.network === "string" ? p.network : null,
      x402Version: typeof p.x402Version === "number" ? p.x402Version : null,
    },
  };
}

/**
 * What a decoded transfer must match for Untch to send it.
 *
 * The official client is trusted to be protocol-correct and is NOT trusted to be correct about
 * amounts. It is a serializer: it faithfully encodes whatever requirements it was handed, and if a
 * requirement were wrong it would encode that just as faithfully. So the bytes are decoded and
 * compared against the challenge Untch validated, and a mismatch is a refusal.
 */
export interface DecodedTransfer {
  readonly amount: bigint | null;
  readonly mint: string | null;
  readonly feePayer: string | null;
  readonly signerCount: number;
  readonly hasBlockhash: boolean;
  readonly programIds: readonly string[];
}

/**
 * Decode the wire transaction far enough to check it.
 *
 * Deliberately structural rather than exhaustive. What matters is that the bytes about to be sent
 * describe the transfer that was authorised: the right mint, the right amount, the sponsor as fee
 * payer, and a lifetime. Re-implementing a full transaction parser would be a second place for the
 * format to drift, so this reads what the caller needs and reports honestly when it cannot.
 */
export async function decodeSvmTransfer(wireTransaction: string): Promise<DecodedTransfer> {
  const kit = await import("@solana/kit");
  const raw = Buffer.from(wireTransaction, "base64");

  try {
    // @solana/kit brands its byte arrays readonly, so the shapes below are asserted through unknown.
    // Widening a readonly view to a mutable one would be the wrong fix: nothing here writes.
    const decoded = kit.getTransactionDecoder().decode(new Uint8Array(raw)) as unknown as {
      messageBytes: Uint8Array;
      signatures: Record<string, unknown>;
    };
    const message = kit.getCompiledTransactionMessageDecoder().decode(decoded.messageBytes) as unknown as {
      staticAccounts?: string[];
      instructions?: { programAddressIndex: number; data?: Uint8Array; accountIndices?: readonly number[] }[];
      lifetimeToken?: string;
    };

    const accounts = message.staticAccounts ?? [];
    const programIds = (message.instructions ?? []).map(
      (ix) => accounts[ix.programAddressIndex] ?? "(unknown)",
    );

    /**
     * `transferChecked` is SPL instruction 12: one discriminator byte, then a u64 amount, then a
     * u8 decimals. Reading the amount from the bytes is the point of decoding at all, because it is
     * the one field a wrong requirement would carry through silently.
     */
    let amount: bigint | null = null;
    let mint: string | null = null;
    for (const ix of message.instructions ?? []) {
      const data = ix.data;
      if (!data || data.length < 10 || data[0] !== 12) continue;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      amount = view.getBigUint64(1, true);
      // transferChecked account order is [source, mint, destination, authority].
      const mintIndex = ix.accountIndices?.[1];
      mint = mintIndex === undefined ? null : (accounts[mintIndex] ?? null);
      break;
    }

    return {
      amount,
      mint,
      feePayer: accounts[0] ?? null,
      signerCount: Object.keys(decoded.signatures ?? {}).length,
      hasBlockhash: typeof message.lifetimeToken === "string" && message.lifetimeToken.length > 0,
      programIds,
    };
  } catch (err) {
    throw new ProviderError(
      normalizedError(
        "PROVIDER_MALFORMED_RESPONSE",
        `could not decode the transaction the official client produced: ${(err as Error).message}. ` +
          "Refusing to send bytes that cannot be inspected.",
      ),
    );
  }
}
