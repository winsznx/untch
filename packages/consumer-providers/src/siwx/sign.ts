/**
 * SIWX — Sign-In With X.
 *
 * The Stable* family gates its *management* endpoints (StableMerch drafts, StableDomains DNS and
 * registrant profile) behind a wallet signature rather than a payment. The 402 that carries it has an
 * EMPTY `accepts[]` and an `extensions["sign-in-with-x"]` block; the reply goes back in a
 * `SIGN-IN-WITH-X` header (declared as `{"type":"apiKey","in":"header"}` in their OpenAPI).
 *
 * On Base the signature type is `eip191` — plain `personal_sign` over the message text — which viem
 * already does, so no new dependency is needed. The identity key is SEPARATE from every treasury key
 * and is deliberately powerless: it proves who is asking, never authorises a spend. Untch's own
 * dashboard already uses SIWE for exactly this separation, so the posture is consistent rather than
 * novel.
 *
 * The one thing this module will not do is invent the message text. EIP-4361 fixes the layout, and a
 * server that verifies a canonically-rendered message will reject a hand-rolled variant — so the
 * renderer below follows EIP-4361 field-for-field and is asserted against a golden string in the
 * tests. If a provider turns out to verify some other rendering, that is a fact to be discovered from
 * a real exchange and encoded here, not smoothed over with a fallback.
 */

import { normalizedError, ProviderError } from "@untch/consumer-core";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { SiwxRequest } from "../x402/challenge";

export interface SiwxCredential {
  readonly headerName: "SIGN-IN-WITH-X";
  readonly headerValue: string;
  readonly address: string;
  readonly expiresAt: string | null;
}

/**
 * Render the EIP-4361 message. Field order and punctuation are fixed by the standard; the optional
 * blocks are emitted only when present, because an empty optional line changes the digest.
 */
export function renderSiwxMessage(req: SiwxRequest, address: string): string {
  const lines: string[] = [];
  lines.push(`${req.domain} wants you to sign in with your account:`);
  lines.push(address);
  lines.push("");
  if (req.statement !== null && req.statement !== "") {
    lines.push(req.statement);
    lines.push("");
  }
  lines.push(`URI: ${req.uri}`);
  lines.push(`Version: ${req.version}`);
  lines.push(`Chain ID: ${req.chainId}`);
  lines.push(`Nonce: ${req.nonce}`);
  lines.push(`Issued At: ${req.issuedAt}`);
  if (req.expirationTime !== null) lines.push(`Expiration Time: ${req.expirationTime}`);
  return lines.join("\n");
}

export interface SiwxSignerDeps {
  /** The identity key. Holds no funds and authorises no spend. */
  readonly privateKey: Hex | null;
  readonly clock?: () => number;
}

export class SiwxSigner {
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private readonly clock: () => number;

  constructor(deps: SiwxSignerDeps) {
    this.account = deps.privateKey ? privateKeyToAccount(deps.privateKey) : null;
    this.clock = deps.clock ?? Date.now;
  }

  available(): boolean {
    return this.account !== null;
  }

  address(): string {
    if (!this.account) throw new Error("no SIWX identity key configured");
    return this.account.address;
  }

  /**
   * Answer a SIWX challenge. Refuses an already-expired challenge and any signature type other than
   * `eip191` — an ed25519 (Solana) challenge needs a Solana key this build does not carry, and
   * signing the wrong curve produces a credential the server will simply reject.
   */
  async sign(req: SiwxRequest): Promise<SiwxCredential> {
    if (!this.account) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_UNAUTHORIZED",
          "this endpoint requires SIWX wallet authentication, but no CONSUMER_SIWX_PRIVATE_KEY is " +
            "configured on this instance",
        ),
      );
    }
    if (req.type !== "eip191") {
      const supported = req.supportedChains.filter((c) => c.type === "eip191");
      throw new ProviderError(
        normalizedError(
          "PROVIDER_UNAUTHORIZED",
          `SIWX signature type '${req.type}' is not supported` +
            (supported.length > 0
              ? ` (this build signs eip191; the provider also offers ${supported.map((c) => c.chainId).join(", ")})`
              : ""),
        ),
      );
    }
    if (req.expirationTime !== null && Date.parse(req.expirationTime) <= this.clock()) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_UNAUTHORIZED",
          "the SIWX challenge had already expired when it was received; re-request it",
        ),
      );
    }

    const address = this.account.address;
    const message = renderSiwxMessage(req, address);
    const signature = await this.account.signMessage({ message });

    const credential = {
      domain: req.domain,
      address,
      statement: req.statement,
      uri: req.uri,
      version: req.version,
      chainId: req.chainId,
      type: req.type,
      nonce: req.nonce,
      issuedAt: req.issuedAt,
      ...(req.expirationTime === null ? {} : { expirationTime: req.expirationTime }),
      signature,
    };

    return {
      headerName: "SIGN-IN-WITH-X",
      headerValue: Buffer.from(JSON.stringify(credential), "utf8").toString("base64"),
      address,
      expiresAt: req.expirationTime,
    };
  }
}
