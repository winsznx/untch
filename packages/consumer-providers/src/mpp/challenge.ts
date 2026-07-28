/**
 * MPP (Machine Payments Protocol) challenge parsing — and an honest refusal to execute it.
 *
 * Every Stable* provider answers a 402 with BOTH an x402 `PAYMENT-REQUIRED` header and an MPP
 * `WWW-Authenticate: Payment` header. The live captures (2026-07-27) show the MPP form as:
 *
 *   WWW-Authenticate: Payment id="…", realm="stabledomains.dev", method="tempo", intent="charge",
 *                     request="<base64>", expires="2026-07-27T17:19:27.114Z"
 *
 * with `request` decoding to:
 *
 *   { "amount": "0",
 *     "currency": "0x20c000000000000000000000b9537d11c60e8b50",
 *     "methodDetails": { "chainId": 4217 },
 *     "recipient": "0xABcb091D90419E1c8AD4818f1B33FC4645501892" }
 *
 * The parsing is real and fully tested — it matters because a client that sees only
 * `WWW-Authenticate` and no `PAYMENT-REQUIRED` needs to report "MPP-only provider" rather than
 * "malformed 402".
 *
 * Executing it is a different matter. `currency` is a 32-byte identifier, not obviously an ERC-20
 * address, and its decimals are unknown. Constructing a Tempo charge from that would mean guessing
 * both the token's precision and the authorization format — i.e. guessing the factor a purchase is
 * multiplied by. The rail is therefore parsed, surfaced, and refused, and `tempo.mpp` sits in the
 * asset registry as UNCONFIRMED with that reason recorded.
 */

import {
  normalizedError,
  ProviderError,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
  type AssetRef,
  type CaipChainId,
  type Money,
} from "@untch/consumer-core";
import { obj, optStr, str, validated } from "../schema";

export interface MppChallenge {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  readonly expires: string | null;
  readonly request: MppChargeRequest | null;
  /** The raw base64, kept so an operator can inspect what we could not decode. */
  readonly rawRequest: string | null;
}

export interface MppChargeRequest {
  readonly amount: string;
  readonly currency: string;
  readonly recipient: string;
  readonly chainId: number | null;
}

/**
 * Parse `WWW-Authenticate: Payment k="v", …`. Written as a small state machine rather than a regex
 * split on commas: a quoted value may legitimately contain a comma (base64 does not, but `realm`
 * could), and a parser that breaks on that would silently drop the rest of the challenge.
 */
export function parseWwwAuthenticate(header: string | undefined): MppChallenge | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^Payment\b/i.test(trimmed)) return null;
  const rest = trimmed.slice("Payment".length).trim();

  const params = new Map<string, string>();
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && (rest[i] === "," || rest[i] === " ")) i += 1;
    const eq = rest.indexOf("=", i);
    if (eq === -1) break;
    const key = rest.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    let value: string;
    if (rest[i] === '"') {
      const close = rest.indexOf('"', i + 1);
      if (close === -1) break;
      value = rest.slice(i + 1, close);
      i = close + 1;
    } else {
      let end = i;
      while (end < rest.length && rest[end] !== ",") end += 1;
      value = rest.slice(i, end).trim();
      i = end;
    }
    if (key !== "") params.set(key, value);
  }

  const rawRequest = params.get("request") ?? null;
  return {
    id: params.get("id") ?? "",
    realm: params.get("realm") ?? "",
    method: params.get("method") ?? "",
    intent: params.get("intent") ?? "",
    expires: params.get("expires") ?? null,
    request: rawRequest === null ? null : decodeChargeRequest(rawRequest),
    rawRequest,
  };
}

function decodeChargeRequest(rawBase64: string): MppChargeRequest | null {
  let decoded: unknown;
  try {
    // The captures use unpadded base64url; Buffer handles both when told it is base64url.
    decoded = JSON.parse(Buffer.from(rawBase64, "base64url").toString("utf8")) as unknown;
  } catch {
    try {
      decoded = JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8")) as unknown;
    } catch {
      return null;
    }
  }
  try {
    return validated("MPP charge request", () => {
      const o = obj(decoded, "mpp.request");
      const details = o.methodDetails === undefined || o.methodDetails === null
        ? {}
        : obj(o.methodDetails, "mpp.request.methodDetails");
      const chainRaw = details.chainId;
      return {
        amount: str(o.amount, "mpp.request.amount", 80),
        currency: str(o.currency, "mpp.request.currency", 128),
        recipient: str(o.recipient, "mpp.request.recipient", 128),
        chainId: typeof chainRaw === "number" && Number.isSafeInteger(chainRaw) ? chainRaw : null,
      };
    });
  } catch {
    return null;
  }
}

/** True when a 402 offered MPP but no acceptable x402 option — an operator-actionable distinction. */
export function isMppOnly(hasX402Options: boolean, mpp: MppChallenge | null): boolean {
  return !hasX402Options && mpp !== null && mpp.request !== null;
}

/**
 * The Tempo/MPP rail client. Present so the treasury router's rail map is total over every chain a
 * provider might name, and so `availableRails()` reports the truth rather than omitting Tempo and
 * leaving a caller to wonder whether it was forgotten.
 */
export class MppTempoClient implements RailClient {
  readonly chain: CaipChainId;

  constructor(deps: { readonly chain: CaipChainId }) {
    this.chain = deps.chain;
  }

  address(): string {
    throw new Error("the Tempo/MPP rail is not executable in this build");
  }

  available(): boolean {
    return false;
  }

  async balanceOf(_asset: AssetRef): Promise<Money> {
    throw new ProviderError(
      normalizedError(
        "PROTOCOL_NOT_EXECUTABLE",
        "the Tempo/MPP rail has no confirmed currency encoding, so a balance cannot be read in the " +
          "right units",
      ),
    );
  }

  async pay(_req: PaymentRequest): Promise<PaymentResult> {
    throw new ProviderError(
      normalizedError(
        "PROTOCOL_NOT_EXECUTABLE",
        "the Tempo/MPP rail is parsed but not executable: the advertised currency identifier " +
          "(0x20c0…8b50 on chainId 4217) could not be confirmed as an ERC-20 address, so its decimals " +
          "are unknown. Constructing a charge would mean guessing the factor the amount is scaled by.",
      ),
    );
  }
}
