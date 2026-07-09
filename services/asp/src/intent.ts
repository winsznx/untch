import {
  canonAddress,
  canonUint256,
  canonUrl,
  hashSpendIntent,
  type SpendIntent,
} from "@untch/canon";
import type { SpendIntentInput } from "@untch/policy-engine";
import type { Address, Hex } from "viem";

/**
 * Wire ⇄ engine intent parsing for the two Step-2 tools.
 *
 * Both `create_spend_intent` and `preflight_payment` receive a spend intent as JSON over HTTP.
 * JSON has no bigint, so — per PRD §9's numeric policy (enforced by `@untch/canon`'s
 * `canonUint256`, which REJECTS JS numbers) — every uint256 field arrives as a decimal STRING of
 * integer base units. This module validates the untrusted wire object (I3), normalizes it into
 * the canonical form used everywhere (addresses lowercased via `canonAddress`, urls via `canonUrl`,
 * uints as bigints), and computes the `intentHash` with `@untch/canon`'s `hashSpendIntent` over the
 * §8.1 bounded object — the SAME hashing path `@untch/policy-engine`'s `evaluateIntent` uses
 * internally, so a hash minted by `create_spend_intent` is byte-identical to the one the policy
 * engine derives for the same intent. Nothing here is reimplemented from those packages.
 *
 * A spend intent has two field groups:
 *   • the 11 §8.1 struct fields — the bounded object that is hashed (owner…nonce);
 *   • the operational §8 `spend_intents` columns the preflight rules read (endpoint, paramsHash,
 *     recipientAddress, category, amount). These are NOT part of the §8.1 hash, but a real spend
 *     intent carries them and the policy engine needs them, so both tools require the full record.
 */

/** §11 error envelope `{code, message, retryable, docsUrl}` — raised on any malformed intent. */
export class IntentValidationError extends Error {
  constructor(
    public readonly reasons: string[],
    public readonly code = "INTENT_MALFORMED",
  ) {
    super(reasons.join("; "));
    this.name = "IntentValidationError";
  }
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new IntentValidationError(["intent must be a JSON object"]);
  }
  return raw as Record<string, unknown>;
}

/** Parse a required uint256 wire field: a decimal string (§9). Rejects JS numbers, per §9. */
function reqUint(r: Record<string, unknown>, key: string, reasons: string[]): bigint {
  const v = r[key];
  if (typeof v === "number") {
    reasons.push(`${key} must be a decimal STRING of base units, not a JSON number (§9 numeric policy)`);
    return 0n;
  }
  if (typeof v !== "string") {
    reasons.push(`${key} is required as a decimal uint256 string`);
    return 0n;
  }
  try {
    return BigInt(canonUint256(v)); // canonUint256 validates format + uint256 range
  } catch (err) {
    reasons.push(`${key}: ${(err as Error).message}`);
    return 0n;
  }
}

function reqAddress(r: Record<string, unknown>, key: string, reasons: string[]): Address {
  const v = r[key];
  if (typeof v !== "string") {
    reasons.push(`${key} is required as a 20-byte hex address`);
    return "0x0000000000000000000000000000000000000000";
  }
  try {
    return canonAddress(v); // lowercases; §9 addresses-lowercased-for-hashing
  } catch {
    reasons.push(`${key} is not a valid 20-byte hex address`);
    return "0x0000000000000000000000000000000000000000";
  }
}

function reqBytes32(r: Record<string, unknown>, key: string, reasons: string[]): Hex {
  const v = r[key];
  if (typeof v !== "string" || !BYTES32.test(v)) {
    reasons.push(`${key} is not a 0x-prefixed 32-byte hex string`);
    return `0x${"0".repeat(64)}`;
  }
  return v.toLowerCase() as Hex; // case-insensitive for the ABI hash; lowercase for determinism
}

/** The 11 §8.1 struct fields as a `@untch/canon` `SpendIntent`, plus its `intentHash`. */
export interface ParsedStruct {
  readonly struct: SpendIntent;
  readonly intentHash: Hex;
}

/** Parse + validate the §8.1 bounded object and hash it. Throws `IntentValidationError` if any
 *  field is missing/malformed — never returns a partial or a guessed hash. */
export function parseStruct(raw: unknown): ParsedStruct {
  const r = asObject(raw);
  const reasons: string[] = [];

  const struct: SpendIntent = {
    owner: reqAddress(r, "owner", reasons),
    buyerAgentId: reqUint(r, "buyerAgentId", reasons),
    workerAgentId: reqUint(r, "workerAgentId", reasons),
    token: reqAddress(r, "token", reasons),
    maxAmount: reqUint(r, "maxAmount", reasons),
    taskHash: reqBytes32(r, "taskHash", reasons),
    acceptanceHash: reqBytes32(r, "acceptanceHash", reasons),
    schemaHash: reqBytes32(r, "schemaHash", reasons),
    policyHash: reqBytes32(r, "policyHash", reasons),
    deadline: reqUint(r, "deadline", reasons),
    nonce: reqUint(r, "nonce", reasons),
  };

  if (reasons.length > 0) throw new IntentValidationError(reasons);
  return { struct, intentHash: hashSpendIntent(struct) };
}

/** The operational §8 `spend_intents` columns the preflight rules read (not part of the §8.1 hash). */
export interface OperationalFields {
  readonly endpoint: string;
  readonly paramsHash: Hex;
  readonly recipientAddress: Address;
  readonly category: string;
  readonly amount: number;
}

/** Parse + validate the operational fields. Throws `IntentValidationError` on any problem. */
export function parseOperational(raw: unknown): OperationalFields {
  const r = asObject(raw);
  const reasons: string[] = [];

  let endpoint = "";
  if (typeof r.endpoint !== "string") {
    reasons.push("endpoint is required as an absolute URL");
  } else {
    try {
      endpoint = canonUrl(r.endpoint);
    } catch {
      reasons.push("endpoint is not an absolute URL");
    }
  }

  const paramsHash = reqBytes32(r, "paramsHash", reasons);
  const recipientAddress = reqAddress(r, "recipientAddress", reasons);

  const category = typeof r.category === "string" ? r.category.trim() : "";
  if (category.length === 0) reasons.push("category is required as a non-empty string");

  const amount = r.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    reasons.push("amount is required as a finite, non-negative number (display units)");
  }

  if (reasons.length > 0) throw new IntentValidationError(reasons);
  return { endpoint, paramsHash, recipientAddress, category, amount: amount as number };
}

/**
 * The full intent: §8.1 struct fields + operational fields, assembled into the exact
 * `SpendIntentInput` `@untch/policy-engine` consumes. Both tools require the full record — the
 * struct is what gets hashed, the operational fields are what the rules read.
 */
export function toSpendIntentInput(struct: SpendIntent, op: OperationalFields): SpendIntentInput {
  return {
    owner: struct.owner,
    buyerAgentId: struct.buyerAgentId,
    workerAgentId: struct.workerAgentId,
    token: struct.token,
    maxAmount: struct.maxAmount,
    taskHash: struct.taskHash,
    acceptanceHash: struct.acceptanceHash,
    schemaHash: struct.schemaHash,
    policyHash: struct.policyHash,
    deadline: struct.deadline,
    nonce: struct.nonce,
    endpoint: op.endpoint,
    paramsHash: op.paramsHash,
    recipientAddress: op.recipientAddress,
    category: op.category,
    amount: op.amount,
  };
}

/**
 * Parse a full intent (struct + operational) into a `SpendIntentInput` and its `intentHash`.
 * Used by `create_spend_intent` (to hash + cache) and by `preflight_payment`'s inline-intent path.
 */
export function parseFullIntent(raw: unknown): { input: SpendIntentInput; intentHash: Hex } {
  const { struct, intentHash } = parseStruct(raw);
  const op = parseOperational(raw);
  return { input: toSpendIntentInput(struct, op), intentHash };
}

/**
 * The canonical, JSON-safe view of an intent returned to callers — the §8.1 bounded object (what
 * `intentHash` covers) with uints as decimal strings and addresses lowercased, plus the operational
 * fields echoed alongside so nothing is lost. This is the honest "canonical form": the `struct`
 * block is byte-for-byte the values `hashSpendIntent` ABI-encoded.
 */
export interface CanonicalIntentView {
  readonly struct: {
    owner: Address;
    buyerAgentId: string;
    workerAgentId: string;
    token: Address;
    maxAmount: string;
    taskHash: Hex;
    acceptanceHash: Hex;
    schemaHash: Hex;
    policyHash: Hex;
    deadline: string;
    nonce: string;
  };
  readonly operational: {
    endpoint: string;
    paramsHash: Hex;
    recipientAddress: Address;
    category: string;
    amount: number;
  };
}

export function toCanonicalView(input: SpendIntentInput): CanonicalIntentView {
  return {
    struct: {
      owner: input.owner,
      buyerAgentId: canonUint256(input.buyerAgentId),
      workerAgentId: canonUint256(input.workerAgentId),
      token: input.token,
      maxAmount: canonUint256(input.maxAmount),
      taskHash: input.taskHash,
      acceptanceHash: input.acceptanceHash,
      schemaHash: input.schemaHash,
      policyHash: input.policyHash,
      deadline: canonUint256(input.deadline),
      nonce: canonUint256(input.nonce),
    },
    operational: {
      endpoint: input.endpoint,
      paramsHash: input.paramsHash,
      recipientAddress: input.recipientAddress,
      category: input.category,
      amount: input.amount,
    },
  };
}
