import { hashCanonicalJson } from "@untch/canon";
import type { Hex } from "viem";
import type { AcceptanceCriteria } from "../src/index";

/** Fixed clock so every VerifyOutcome.verifiedAt is deterministic in tests. */
export const NOW = Date.parse("2026-07-11T12:00:00Z");
export const now = (): number => NOW;

export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
export const INTENT_HASH = `0x${"ab".repeat(32)}` as Hex;

/** The committed acceptanceHash for a criteria doc is exactly its §9 canonical-JSON keccak — the same
 *  value `create_spend_intent` commits when the buyer sets acceptanceHash = hashCanonicalJson(criteria). */
export function commit(criteria: AcceptanceCriteria): Hex {
  return hashCanonicalJson(criteria);
}

/** A representative market-data acceptance spec exercising every T0 check at once. */
export function marketDataCriteria(): AcceptanceCriteria {
  return {
    canonVersion: "1",
    schema: {
      type: "object",
      required: ["symbol", "price", "asOf"],
      properties: {
        symbol: { type: "string" },
        price: { type: "number", minimum: 0 },
        asOf: { type: "string" },
      },
      additionalProperties: true,
    },
    requiredFields: ["symbol", "price", "asOf"],
    sizeBounds: { maxBytes: 512, minBytes: 8 },
    fieldConstraints: [
      { field: "symbol", regex: "[A-Z0-9]{2,10}", maxLen: 10 },
      { field: "asOf", regex: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z" },
    ],
  };
}

/** A conformant market-data payload for `marketDataCriteria`. */
export function goodMarketData(): Record<string, unknown> {
  return { symbol: "OKB", price: 48.15, asOf: "2026-07-11T11:59:00Z" };
}
