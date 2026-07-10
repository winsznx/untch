import type { OnPerCallCapExceeded, PolicyRules } from "@untch/policy-engine";
import type { Address } from "viem";

/**
 * Untrusted-rules boundary. A policy's rules arrive as arbitrary JSON (from the create/update tool),
 * get canonicalized+hashed, and are stored AND later evaluated verbatim by @untch/policy-engine. So
 * they must be validated to the engine's `PolicyRules` shape up front — a malformed ruleset must be
 * rejected at creation, never stored to fail-close later or, worse, evaluate on a half-shape. This is
 * the one place that knows both the wire (untrusted) and the engine (typed) sides.
 */
export class PolicyValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

function fail(message: string): never {
  throw new PolicyValidationError("POLICY_RULES_MALFORMED", message);
}

function asObject(x: unknown, path: string): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) fail(`${path} must be an object`);
  return x as Record<string, unknown>;
}

function asFiniteNumber(x: unknown, path: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) fail(`${path} must be a finite number`);
  return x as number;
}

function asNonNegNumber(x: unknown, path: string): number {
  const n = asFiniteNumber(x, path);
  if (n < 0) fail(`${path} must be >= 0`);
  return n;
}

function asNonEmptyString(x: unknown, path: string): string {
  if (typeof x !== "string" || x.trim().length === 0) fail(`${path} must be a non-empty string`);
  return x;
}

function asStringArray(x: unknown, path: string): string[] {
  if (!Array.isArray(x)) fail(`${path} must be an array`);
  return x.map((v, i) => {
    if (typeof v !== "string") fail(`${path}[${i}] must be a string`);
    return v;
  });
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function asAddressArray(x: unknown, path: string): Address[] {
  return asStringArray(x, path).map((v, i) => {
    if (!ADDRESS_RE.test(v)) fail(`${path}[${i}] is not a 20-byte hex address`);
    return v as Address;
  });
}

function asOnPerCallCap(x: unknown, path: string): OnPerCallCapExceeded | undefined {
  if (x === undefined) return undefined;
  if (x !== "ESCALATE" && x !== "BLOCK") fail(`${path} must be "ESCALATE" or "BLOCK"`);
  return x;
}

/**
 * Validate untrusted JSON to the engine's `PolicyRules`, then return the ORIGINAL object (not a
 * rebuilt subset). Only the fields the ten implemented rules read are required — but any extra §8
 * fields the operator submits (approvals, vendors, proof, anchorIntentsAbove, metadataRedaction,
 * timeWindows …) are preserved verbatim, so the canonical `policyHash` anchored on-chain covers
 * EXACTLY what was submitted, never a silently-stripped subset. The engine narrows to its own slice
 * at read time and ignores the extras. `expiry` must be a parseable ISO-8601 instant — the engine
 * fail-closes on an unparseable one, so we reject it at the door.
 */
export function parsePolicyRules(input: unknown): PolicyRules {
  const r = asObject(input, "rules");

  const budgets = asObject(r.budgets, "rules.budgets");
  const categories = asObject(r.categories, "rules.categories");
  const recipients = asObject(r.recipients, "rules.recipients");
  const agents = asObject(r.agents, "rules.agents");
  const duplicates = asObject(r.duplicates, "rules.duplicates");
  const cooldowns = asObject(r.cooldowns, "rules.cooldowns");
  const rateLimit = asObject(r.rateLimit, "rules.rateLimit");

  const expiry = asNonEmptyString(r.expiry, "rules.expiry");
  if (Number.isNaN(Date.parse(expiry))) fail("rules.expiry is not a parseable ISO-8601 instant");

  asNonNegNumber(budgets.daily, "rules.budgets.daily");
  asNonEmptyString(budgets.token, "rules.budgets.token");
  asNonNegNumber(r.perCallCap, "rules.perCallCap");
  asOnPerCallCap(r.onPerCallCapExceeded, "rules.onPerCallCapExceeded");
  asNonNegNumber(r.escalateAbove, "rules.escalateAbove");
  asStringArray(categories.allow, "rules.categories.allow");
  asStringArray(categories.deny, "rules.categories.deny");
  asAddressArray(recipients.allow, "rules.recipients.allow");
  asAddressArray(recipients.deny, "rules.recipients.deny");
  asStringArray(agents.allowWorkerIds, "rules.agents.allowWorkerIds");
  asStringArray(agents.denyWorkerIds, "rules.agents.denyWorkerIds");
  asNonNegNumber(duplicates.ttlMin, "rules.duplicates.ttlMin");
  asStringArray(duplicates.keys, "rules.duplicates.keys");
  asNonNegNumber(cooldowns.sameServiceMin, "rules.cooldowns.sameServiceMin");
  asNonNegNumber(rateLimit.callsPerHour, "rules.rateLimit.callsPerHour");

  // Validated in place; the original object (with any extra §8 fields) is what we store AND hash.
  return r as unknown as PolicyRules;
}
