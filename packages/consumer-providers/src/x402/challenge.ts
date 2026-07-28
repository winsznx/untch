/**
 * x402 v2 challenge parsing and payment-option selection.
 *
 * The shapes here are not read from a spec summary — they are read from real 402 responses captured
 * on 2026-07-27 and committed under internal/consumer-pack-evidence/. Three facts from those
 * captures shape this module:
 *
 *   1. `accepts[]` may offer SEVERAL rails for the same resource. StableDomains offers Base USDC and
 *      Solana USDC for the same $20 registration. Selection is therefore a real decision, made
 *      against the settlement allowlist and the rails we can actually sign for — not "take the first".
 *
 *   2. On Base, `extra` is `{name: "USD Coin", version: "2"}` — the EIP-712 domain for EIP-3009
 *      `transferWithAuthorization`, i.e. exactly the scheme Untch already settles on X Layer. On
 *      Solana, `extra` is `{feePayer}` — a sponsored SPL transfer, a completely different signing act.
 *
 *   3. An EMPTY `accepts[]` combined with an `extensions["sign-in-with-x"]` block is NOT a payment
 *      challenge at all. It is SIWX authentication. StableMerch's /api/catalog and /api/drafts and
 *      StableDomains' /api/domain/dns all answer this way. A client that treats an empty accepts as
 *      "no acceptable rail" reports the wrong error; a client that loops on it never terminates.
 *      `classifyChallenge` exists so that distinction is made once, explicitly.
 */

import {
  isAllowedSettlementAsset,
  lookupAsset,
  money,
  normalizedError,
  ProviderError,
  type CaipChainId,
  type ConfirmedAsset,
  type Money,
} from "@untch/consumer-core";
import { arr, atomic, dig, int, obj, optStr, str, validated } from "../schema";

export interface X402PaymentOption {
  readonly scheme: string;
  readonly network: CaipChainId;
  /** Atomic amount, exactly as the provider stated it. */
  readonly amount: bigint;
  /** Contract address (EVM) or SPL mint (Solana). */
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface X402Challenge {
  readonly x402Version: number;
  readonly resource: { readonly url: string; readonly description: string; readonly mimeType: string };
  readonly accepts: readonly X402PaymentOption[];
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly error: string | null;
}

/** The SIWX authentication request that arrives dressed as a 402. */
export interface SiwxRequest {
  readonly domain: string;
  readonly uri: string;
  readonly version: string;
  readonly chainId: string;
  /** "eip191" on Base; "ed25519" on Solana. */
  readonly type: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string | null;
  readonly statement: string | null;
  readonly supportedChains: readonly { readonly chainId: string; readonly type: string }[];
}

export type ChallengeKind =
  | { readonly kind: "payment"; readonly challenge: X402Challenge }
  | { readonly kind: "siwx"; readonly request: SiwxRequest; readonly challenge: X402Challenge }
  | { readonly kind: "none" };

/** Decode the base64 `PAYMENT-REQUIRED` header, or the JSON body when a provider inlines it. */
export function decodeChallengeHeader(headerValue: string | undefined): unknown {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  // Providers send base64 in the header; some also mirror the JSON into the body.
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(Buffer.from(trimmed, "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export function parseChallenge(raw: unknown): X402Challenge {
  return validated("x402 challenge", () => {
    const root = obj(raw, "challenge");
    const resource = obj(root.resource ?? {}, "challenge.resource");
    const accepts = arr(root.accepts ?? [], "challenge.accepts").map((entry, i) => {
      const o = obj(entry, `challenge.accepts[${i}]`);
      return {
        scheme: str(o.scheme, `challenge.accepts[${i}].scheme`, 64),
        network: str(o.network, `challenge.accepts[${i}].network`, 128) as CaipChainId,
        amount: atomic(o.amount, `challenge.accepts[${i}].amount`),
        asset: str(o.asset, `challenge.accepts[${i}].asset`, 128),
        payTo: str(o.payTo, `challenge.accepts[${i}].payTo`, 128),
        maxTimeoutSeconds:
          o.maxTimeoutSeconds === undefined || o.maxTimeoutSeconds === null
            ? 300
            : int(o.maxTimeoutSeconds, `challenge.accepts[${i}].maxTimeoutSeconds`),
        extra:
          o.extra === undefined || o.extra === null
            ? {}
            : obj(o.extra, `challenge.accepts[${i}].extra`),
      } satisfies X402PaymentOption;
    });
    return {
      x402Version: root.x402Version === undefined ? 2 : int(root.x402Version, "challenge.x402Version"),
      resource: {
        url: optStr(resource.url, "challenge.resource.url", 2048) ?? "",
        description: optStr(resource.description, "challenge.resource.description", 500) ?? "",
        mimeType: optStr(resource.mimeType, "challenge.resource.mimeType", 120) ?? "application/json",
      },
      accepts,
      extensions:
        root.extensions === undefined || root.extensions === null
          ? {}
          : obj(root.extensions, "challenge.extensions"),
      error: optStr(root.error, "challenge.error", 300),
    };
  });
}

/**
 * Decide what a 402 actually is. The empty-`accepts`-plus-SIWX case is the one that matters: it is
 * authentication, and calling it "no acceptable payment rail" would send an operator hunting for a
 * treasury problem that does not exist.
 */
export function classifyChallenge(raw: unknown): ChallengeKind {
  if (raw === null || raw === undefined) return { kind: "none" };
  const challenge = parseChallenge(raw);
  const siwxInfo = dig(challenge.extensions, "sign-in-with-x", "info");
  if (challenge.accepts.length === 0 && siwxInfo !== undefined) {
    return { kind: "siwx", request: parseSiwx(challenge), challenge };
  }
  if (challenge.accepts.length === 0) return { kind: "none" };
  return { kind: "payment", challenge };
}

function parseSiwx(challenge: X402Challenge): SiwxRequest {
  return validated("SIWX request", () => {
    const ext = obj(dig(challenge.extensions, "sign-in-with-x") ?? {}, "extensions.sign-in-with-x");
    const info = obj(ext.info ?? {}, "extensions.sign-in-with-x.info");
    const supported = arr(ext.supportedChains ?? [], "extensions.sign-in-with-x.supportedChains").map(
      (entry, i) => {
        const o = obj(entry, `supportedChains[${i}]`);
        return {
          chainId: str(o.chainId, `supportedChains[${i}].chainId`, 128),
          type: str(o.type, `supportedChains[${i}].type`, 32),
        };
      },
    );
    return {
      domain: str(info.domain, "siwx.domain", 253),
      uri: str(info.uri, "siwx.uri", 2048),
      version: str(info.version, "siwx.version", 8),
      chainId: str(info.chainId, "siwx.chainId", 128),
      type: str(info.type, "siwx.type", 32),
      nonce: str(info.nonce, "siwx.nonce", 128),
      issuedAt: str(info.issuedAt, "siwx.issuedAt", 64),
      expirationTime: optStr(info.expirationTime, "siwx.expirationTime", 64),
      statement: optStr(info.statement, "siwx.statement", 300),
      supportedChains: supported,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectedPayment {
  readonly option: X402PaymentOption;
  readonly asset: ConfirmedAsset;
  readonly amount: Money;
  readonly recipient: string;
}

export interface SelectionContext {
  /** Rails we hold a signing key for. An option on a rail we cannot sign is not a candidate. */
  readonly signableChains: ReadonlySet<CaipChainId>;
  /** The ceiling the approval authorised, per chain. An option above it is refused, not truncated. */
  readonly ceilingFor: (asset: ConfirmedAsset) => Money | null;
  /** Recipients the approval bound. Empty ⇒ any allowlisted asset's payTo is acceptable (discovery). */
  readonly allowedRecipients?: readonly string[];
}

/**
 * Choose one payment option, or refuse with a reason that names what was wrong.
 *
 * The order of checks is deliberate: the settlement allowlist first (wrong token / wrong chain is the
 * most dangerous class), then signability, then the recipient binding, then the amount ceiling. That
 * way the error a caller sees describes the FIRST thing that made the option unacceptable, which is
 * the one an operator needs to act on.
 */
export function selectPayment(
  challenge: X402Challenge,
  ctx: SelectionContext,
): SelectedPayment {
  const rejections: string[] = [];

  for (const option of challenge.accepts) {
    if (option.scheme !== "exact") {
      rejections.push(`${option.network}: scheme '${option.scheme}' is not supported (only 'exact')`);
      continue;
    }
    if (!isAllowedSettlementAsset(option.network, option.asset)) {
      rejections.push(`${option.network}: asset is not on the settlement allowlist`);
      continue;
    }
    const asset = lookupAsset(option.network, option.asset);
    if (!asset) {
      rejections.push(`${option.network}: asset could not be resolved`);
      continue;
    }
    if (!ctx.signableChains.has(option.network)) {
      rejections.push(`${option.network}: no signing key configured for this rail`);
      continue;
    }
    if (ctx.allowedRecipients && ctx.allowedRecipients.length > 0) {
      const ok = ctx.allowedRecipients.some((r) => r.toLowerCase() === option.payTo.toLowerCase());
      if (!ok) {
        rejections.push(`${option.network}: payTo is not the recipient the approval bound`);
        continue;
      }
    }
    const amount = money(option.amount, asset);
    const ceiling = ctx.ceilingFor(asset);
    if (ceiling !== null && amount.amount > ceiling.amount) {
      rejections.push(
        `${option.network}: ${option.amount} exceeds the authorised ceiling ${ceiling.amount}`,
      );
      continue;
    }
    return { option, asset, amount, recipient: option.payTo };
  }

  throw new ProviderError(
    normalizedError(
      "PAYMENT_CHALLENGE_UNACCEPTABLE",
      challenge.accepts.length === 0
        ? "the 402 offered no payment options"
        : `no acceptable payment option — ${rejections.join("; ")}`,
    ),
  );
}

/**
 * The EIP-3009 domain a Base/EVM option signs under. Read from the CHALLENGE's `extra`, cross-checked
 * against the registry's recorded domain, and refused when they disagree — a provider that changes
 * the domain out from under a known token is either broken or attacking us.
 */
export function eip3009DomainFor(
  option: X402PaymentOption,
  asset: ConfirmedAsset,
): { readonly name: string; readonly version: string } {
  const fromChallenge = {
    name: typeof option.extra.name === "string" ? option.extra.name : null,
    version: typeof option.extra.version === "string" ? option.extra.version : null,
  };
  const recorded = asset.eip3009 ?? null;

  if (fromChallenge.name === null || fromChallenge.version === null) {
    throw new ProviderError(
      normalizedError(
        "PAYMENT_CHALLENGE_UNACCEPTABLE",
        `the ${option.network} challenge did not carry the EIP-3009 domain (extra.name / extra.version); ` +
          "signing an authorization under a guessed domain would produce a signature for a different token",
      ),
    );
  }
  if (recorded && (recorded.name !== fromChallenge.name || recorded.version !== fromChallenge.version)) {
    throw new ProviderError(
      normalizedError(
        "PAYMENT_CHALLENGE_UNACCEPTABLE",
        `the challenge's EIP-3009 domain does not match the one recorded for ${asset.symbol} on ` +
          `${asset.chain} — refusing rather than signing under the provider's version`,
      ),
    );
  }
  return { name: fromChallenge.name, version: fromChallenge.version };
}
