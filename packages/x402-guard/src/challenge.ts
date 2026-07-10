/**
 * x402 402-challenge parsing (PRD §13 Mode B).
 *
 * A seller answers an unpaid paid-route with HTTP 402 and a `PAYMENT-REQUIRED` header carrying a
 * base64url-encoded JSON body of the shape (confirmed against a real D0.1 challenge):
 *
 *   { x402Version, error, resource: { url, ... }, accepts: [ { scheme, network, amount, asset,
 *     payTo, maxTimeoutSeconds, extra: { … } } ] }
 *
 * `parseChallenge` turns that decoded object into a `ParsedChallenge`; `bindingFromChallenge` then
 * assembles the PRESENTED `ChallengeBinding` the guard checks against the caller's authorized one.
 */

import type { ChallengeBinding, ParsedChallenge } from "./types";

export class ChallengeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChallengeParseError";
  }
}

/** Decode a base64 / base64url `PAYMENT-REQUIRED` header value into its JSON object. */
export function decodePaymentRequiredHeader(headerValue: string): unknown {
  const normalized = headerValue.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(normalized, "base64").toString("utf8");
  try {
    return JSON.parse(json);
  } catch {
    throw new ChallengeParseError("PAYMENT-REQUIRED header is not valid base64 JSON");
  }
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ChallengeParseError(`${what} must be an object`);
  }
  return v as Record<string, unknown>;
}

function reqString(r: Record<string, unknown>, key: string, what: string): string {
  const v = r[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  throw new ChallengeParseError(`${what}.${key} is required`);
}

/**
 * Parse a decoded x402 challenge object. When `preferNetwork` is given, the matching `accepts` entry
 * is selected (defence against a challenge that offers several networks); otherwise the first exact
 * entry, else the first entry, is used.
 */
export function parseChallenge(
  decoded: unknown,
  opts: { readonly preferNetwork?: string } = {},
): ParsedChallenge {
  const root = asRecord(decoded, "challenge");
  const accepts = root.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new ChallengeParseError("challenge.accepts must be a non-empty array");
  }

  const entries = accepts.map((a, i) => asRecord(a, `accepts[${i}]`));
  const chosen =
    (opts.preferNetwork
      ? entries.find((e) => e.network === opts.preferNetwork)
      : undefined) ??
    entries.find((e) => e.scheme === "exact") ??
    entries[0]!;

  const resource = root.resource !== undefined ? asRecord(root.resource, "challenge.resource") : {};
  const resourceUrl =
    typeof resource.url === "string" && resource.url.length > 0
      ? resource.url
      : reqString(chosen, "resource", "accepts[]");

  const maxTimeoutRaw = chosen.maxTimeoutSeconds;
  const maxTimeoutSeconds =
    typeof maxTimeoutRaw === "number"
      ? maxTimeoutRaw
      : typeof maxTimeoutRaw === "string" && /^[0-9]+$/.test(maxTimeoutRaw)
        ? Number(maxTimeoutRaw)
        : null;

  const x402Version =
    typeof root.x402Version === "number"
      ? root.x402Version
      : typeof chosen.x402Version === "number"
        ? chosen.x402Version
        : 0;

  return {
    x402Version,
    scheme: reqString(chosen, "scheme", "accepts[]"),
    network: reqString(chosen, "network", "accepts[]"),
    recipient: reqString(chosen, "payTo", "accepts[]"),
    token: reqString(chosen, "asset", "accepts[]"),
    amount: reqString(chosen, "amount", "accepts[]"),
    resourceUrl,
    maxTimeoutSeconds,
    extra:
      chosen.extra !== undefined ? asRecord(chosen.extra, "accepts[].extra") : {},
  };
}

function extraString(extra: Record<string, unknown>, key: string): string | undefined {
  const v = extra[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

export interface RequestContext {
  /** The endpoint the caller actually invoked. Defaults to the challenge's resource URL. */
  readonly endpoint?: string;
  /** The HTTP method the caller invoked. Defaults to `GET`. */
  readonly method?: string;
  /** When the challenge was received (unix ms) — used to derive `expiry` from `maxTimeoutSeconds`. */
  readonly issuedAtMs?: number;
  /**
   * Opt-in: derive `expiry` as `issuedAt + maxTimeoutSeconds` when the challenge carries no explicit
   * `extra.expiry`/`validBefore`. Off by default — when a seller binds no expiry there is nothing to
   * replay-check (the EIP-3009 `validBefore` is chosen inside the caller's own signer, out of view),
   * so the presented `expiry` stays empty and binds against an authorization that also binds none.
   */
  readonly deriveExpiryFromTimeout?: boolean;
}

/**
 * Assemble the PRESENTED `ChallengeBinding` from a parsed challenge + the request context.
 *
 * recipient / token / amount / resourceUrl come straight from the challenge. endpoint / method are
 * the caller's request facts. nonce / expiry / taskHash / intentHash / policyId / metadataHash are
 * read from the challenge's `extra` when the seller bound them; `expiry` additionally falls back to
 * `issuedAt + maxTimeoutSeconds` so a challenge that only sets a timeout still presents a concrete
 * expiry to bind.
 */
export function bindingFromChallenge(
  parsed: ParsedChallenge,
  ctx: RequestContext = {},
): ChallengeBinding {
  const nonce = extraString(parsed.extra, "nonce") ?? "";
  let expiry = extraString(parsed.extra, "expiry") ?? extraString(parsed.extra, "validBefore");
  if (
    expiry === undefined &&
    ctx.deriveExpiryFromTimeout === true &&
    parsed.maxTimeoutSeconds !== null &&
    ctx.issuedAtMs !== undefined
  ) {
    expiry = String(Math.floor(ctx.issuedAtMs / 1000) + parsed.maxTimeoutSeconds);
  }

  const binding: {
    -readonly [K in keyof ChallengeBinding]: ChallengeBinding[K];
  } = {
    recipient: parsed.recipient,
    token: parsed.token,
    amount: parsed.amount,
    resourceUrl: parsed.resourceUrl,
    endpoint: ctx.endpoint ?? parsed.resourceUrl,
    method: ctx.method ?? "GET",
    nonce,
    expiry: expiry ?? "",
  };

  const taskHash = extraString(parsed.extra, "taskHash");
  if (taskHash !== undefined) binding.taskHash = taskHash;
  const intentHash = extraString(parsed.extra, "intentHash");
  if (intentHash !== undefined) binding.intentHash = intentHash;
  const policyId = extraString(parsed.extra, "policyId");
  if (policyId !== undefined) binding.policyId = policyId;
  const metadataHash = extraString(parsed.extra, "metadataHash");
  if (metadataHash !== undefined) binding.metadataHash = metadataHash;

  return binding;
}
