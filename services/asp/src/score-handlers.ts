import {
  scoreVendor,
  scoreBuyer,
  type ScoreDataSource,
  type ScoreResult,
  type WalletProfileProvider,
} from "@untch/trust-bureau";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { HandlerResult } from "./handlers";

/**
 * §11 / §12 Bureau tool handlers — `score_vendor` and `score_buyer` ($0.20 each). Framework-agnostic:
 * each returns `{ status, body }` so it is unit-testable with the REAL scoring engine and an in-memory
 * data source, no network. The response ALWAYS carries the §12 disclaimer and shows, per feature,
 * whether it was observed or a cold-start prior (HARD RULE: a prior is never presented as observed).
 *
 * No LLM anywhere in this path (I1) — the handler only validates input, resolves the subject id, and
 * forwards to the deterministic engine, surfacing its result verbatim.
 */

function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

export interface ScoreDeps {
  readonly dataSource: ScoreDataSource;
  /** RPC provider for wallet_operational_profile. Null ⇒ that feature has no data (neutral, wide σ). */
  readonly walletProvider: WalletProfileProvider | null;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Vendor identity = keccak256("untch-vendor:" + canonical host) — the SAME derivation the receipt
 *  mapping uses, so an `endpoint`/`host` a caller passes resolves to the id its receipts were keyed by. */
function vendorIdFromHost(hostOrUrl: string): Hex {
  let key = hostOrUrl;
  try {
    key = new URL(hostOrUrl).host;
  } catch {
    /* not a URL — use the raw string as the host */
  }
  return keccak256(toHex(`untch-vendor:${key}`));
}

/** Shape the response: full breakdown + a convenience `topFeatures` (highest applied weight first). */
function scoreBody(r: ScoreResult): Record<string, unknown> {
  const topFeatures = [...r.features]
    .sort((a, b) => b.weightApplied - a.weightApplied || b.baseWeight - a.baseWeight)
    .slice(0, 4)
    .map((f) => ({
      key: f.key,
      value: Number(f.value.toFixed(2)),
      sigma: Number(f.sigma.toFixed(2)),
      source: f.source,
      weightApplied: Number(f.weightApplied.toFixed(4)),
    }));
  return {
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    epoch: r.epoch,
    score: Number(r.score.toFixed(2)),
    sigma: Number(r.sigma.toFixed(2)),
    lcb: Number(r.lcb.toFixed(2)),
    z: r.z,
    band: r.band,
    topFeatures,
    features: r.features,
    coldStartFeatures: r.coldStartFeatures,
    uncertainty: r.uncertainty,
    anchoredRoot: r.anchoredRoot,
    computedAt: r.computedAt,
    disclaimer: r.disclaimer,
  };
}

/**
 * `score_vendor` ($0.20). Accepts `{ vendorId }` (0x 32-byte id), or `{ endpoint }` / `{ host }` (the
 * service host, resolved to the same id the receipts were keyed by), plus an optional `payoutAddress`
 * override for the on-chain wallet feature. `listingId` is honestly rejected: resolving a marketplace
 * listing needs OKX.AI listing data, which is unavailable (see README) — the caller must pass a
 * vendorId or endpoint host instead. Nothing here is faked to paper over that gap.
 */
export async function handleScoreVendor(body: unknown, deps: ScoreDeps): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.listingId === "string" && b.listingId.trim() !== "" && b.vendorId === undefined && b.endpoint === undefined && b.host === undefined) {
    return {
      status: 400,
      body: errorEnvelope(
        "LISTING_ID_UNRESOLVABLE",
        "resolving a marketplace listingId needs OKX.AI listing data, which is not available to this build (see README finding). Pass `vendorId` (0x 32-byte) or `endpoint`/`host` instead.",
      ),
    };
  }

  let vendorId: Hex;
  if (typeof b.vendorId === "string" && HEX32.test(b.vendorId.trim())) {
    vendorId = b.vendorId.trim().toLowerCase() as Hex;
  } else if (typeof b.endpoint === "string" && b.endpoint.trim() !== "") {
    vendorId = vendorIdFromHost(b.endpoint.trim());
  } else if (typeof b.host === "string" && b.host.trim() !== "") {
    vendorId = vendorIdFromHost(b.host.trim());
  } else {
    return {
      status: 400,
      body: errorEnvelope(
        "VENDOR_ID_REQUIRED",
        "provide `vendorId` (0x 32-byte hex) or `endpoint`/`host` (the service host, resolved to its vendor id)",
      ),
    };
  }

  let payoutAddress: Address | undefined;
  if (b.payoutAddress !== undefined) {
    if (typeof b.payoutAddress !== "string" || !ADDR.test(b.payoutAddress)) {
      return { status: 400, body: errorEnvelope("PAYOUT_ADDRESS_MALFORMED", "payoutAddress must be a 0x 20-byte address") };
    }
    payoutAddress = b.payoutAddress.toLowerCase() as Address;
  }

  const result = await scoreVendor(deps.dataSource, vendorId, {
    walletProvider: deps.walletProvider,
    ...(payoutAddress ? { payoutAddress } : {}),
    ...(deps.now ? { nowMs: deps.now } : {}),
  });
  return { status: 200, body: scoreBody(result) };
}

/**
 * `score_buyer` ($0.20). Accepts `{ agentId }` as a uint256 (decimal string / number) or a 0x 32-byte
 * id. `operatorRef` is honestly rejected: an operator→agent mapping lives in the §15 dashboard, which
 * does not exist yet — pass the agentId. Hygiene never blocks the buyer's own spend (§12); this only
 * annotates counterparty risk.
 */
export async function handleScoreBuyer(body: unknown, deps: ScoreDeps): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;

  if (b.operatorRef !== undefined && b.agentId === undefined) {
    return {
      status: 400,
      body: errorEnvelope(
        "OPERATOR_REF_UNRESOLVABLE",
        "resolving an operatorRef to an agent needs the dashboard onboarding map (§15), which does not exist yet. Pass `agentId` (uint256 or 0x 32-byte) instead.",
      ),
    };
  }

  let agentId: Hex;
  if (typeof b.agentId === "string" && HEX32.test(b.agentId.trim())) {
    agentId = b.agentId.trim().toLowerCase() as Hex;
  } else if (
    (typeof b.agentId === "string" && /^[0-9]+$/.test(b.agentId.trim())) ||
    (typeof b.agentId === "number" && Number.isInteger(b.agentId) && b.agentId >= 0)
  ) {
    agentId = toHex(BigInt(String(b.agentId).trim()), { size: 32 });
  } else {
    return {
      status: 400,
      body: errorEnvelope("AGENT_ID_REQUIRED", "provide `agentId` as a uint256 (decimal) or a 0x 32-byte hex id"),
    };
  }

  const result = await scoreBuyer(deps.dataSource, agentId, {
    ...(deps.now ? { nowMs: deps.now } : {}),
  });
  return { status: 200, body: scoreBody(result) };
}
