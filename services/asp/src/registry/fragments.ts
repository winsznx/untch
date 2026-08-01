import type { JsonSchema, Predecessor } from "./types";

/**
 * The field shapes that recur across contracts, written once.
 *
 * These are not conveniences. Six of the seventeen fields `preflight_payment` demands are one of
 * these four shapes, and the rule that catches callers out — that uint256 values arrive as decimal
 * STRINGS while `amount` arrives as a JSON number — is invisible when each field is described in
 * isolation. Naming the shapes makes the inversion legible in one place and impossible to describe
 * two different ways in two definitions.
 */

export const BYTES32_PATTERN = "^0x[0-9a-fA-F]{64}$";
export const ADDRESS_PATTERN = "^0x[0-9a-fA-F]{40}$";
export const UINT256_PATTERN = "^[0-9]+$";

export const bytes32 = (description: string): JsonSchema => ({
  type: "string",
  pattern: BYTES32_PATTERN,
  description,
  examples: ["0x" + "ab".repeat(32)],
});

export const address = (description: string): JsonSchema => ({
  type: "string",
  pattern: ADDRESS_PATTERN,
  description,
  examples: ["0xd9ed4d474b0d01031d10d637546450f39ed6a5ba"],
});

/**
 * A uint256 as a decimal string.
 *
 * JSON has no integer type wide enough for uint256, and a JS number silently loses precision above
 * 2^53. The validators reject a JSON number here outright rather than accepting a value they would
 * have to round — so the description says so, because a caller who sends `5000000` and is refused
 * needs to know the fix is quotes, not a different number.
 */
export const uint256String = (description: string): JsonSchema => ({
  type: "string",
  pattern: UINT256_PATTERN,
  description: `${description} Sent as a DECIMAL STRING, not a JSON number — JSON numbers cannot carry uint256 without losing precision, so a number here is refused rather than rounded.`,
  examples: ["1000000"],
});

export const policyIdField: JsonSchema = {
  type: "string",
  pattern: UINT256_PATTERN,
  description:
    "The id of a policy registered on the PolicyRegistry contract, as a decimal string. It names the spending rules this request is judged against.",
  examples: ["7"],
};

export const isoTimestamp = (description: string): JsonSchema => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
  description,
  examples: ["2026-08-01T12:00:00.000Z"],
});

/** The `{code, message, retryable, docsUrl}` envelope every refusal uses. */
export const ERROR_ENVELOPE: JsonSchema = {
  type: "object",
  title: "Refusal",
  description: "The shape of every refusal this service returns, at every status code.",
  properties: {
    code: { type: "string", description: "A stable machine-readable reason. Safe to branch on." },
    message: { type: "string", description: "One sentence a caller can act on." },
    retryable: {
      type: "boolean",
      description: "Whether repeating the identical request could succeed without changing it.",
    },
    docsUrl: { type: ["string", "null"], description: "Where the rule is written down, when it is." },
    correlationId: {
      type: "string",
      description:
        "Present only on an unclassified internal failure. Quote it when reporting; it names the log line holding the cause.",
    },
  },
  required: ["code", "message", "retryable"],
};

/**
 * The predecessor that makes two listed services unreachable.
 *
 * `obtainableBy: null` is a factual claim checked by a test: no registered service produces a policy
 * id. It is recorded here once so both dependent contracts state the same thing, and so the listing
 * generator can refuse to publish a service whose predecessor nobody can satisfy.
 */
export const POLICY_PREDECESSOR: Predecessor = {
  what: "A registered spend policy, and its numeric policyId.",
  why: "Every decision this service makes is a comparison against a policy. Without one there is nothing to compare to, and the request is refused rather than judged.",
  obtainableBy: null,
};

export const POLICY_HASH_PREDECESSOR: Predecessor = {
  what: "The policyHash of that policy — the exact hash the registry stored when it was registered.",
  why: "It binds the request to one VERSION of the rules, so a policy edited after the request was built cannot silently change the answer.",
  obtainableBy: null,
};
