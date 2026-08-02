/**
 * Human-level policy fields → the canonical ruleset the registry hashes.
 *
 * WHY A TRANSLATION EXISTS AT ALL
 *
 * `PolicyRules` is the shape the engine evaluates and `hashCanonicalJson` commits to. It is nested,
 * exhaustive, and every field is load-bearing at decision time — which makes it exactly the wrong
 * thing to hand a person setting up their first policy. `rules.budgets.token`, `rules.duplicates.keys`
 * and `rules.onPerCallCapExceeded` are decisions somebody has to make, and a form that asks for all of
 * them by their internal names produces policies whose limits nobody chose so much as accepted.
 *
 * So the public surface takes the eight things a person actually has an opinion about — what may this
 * spend per action, per day, above what does it ask me, what may it buy, when does it stop — and this
 * module derives the rest. The derivation is DETERMINISTIC and pure: the same input produces the same
 * ruleset and therefore the same policy hash, every time, on any host.
 *
 * WHAT IS NOT HIDDEN
 *
 * The derived ruleset is returned in full beside the transaction, and the draft response shows it. A
 * translation that quietly picked a `perCallCap` the user never saw would be worse than the nested
 * form: they would be signing a commitment to rules they were never shown. The point is to make the
 * defaults VISIBLE and editable, not to make them invisible.
 *
 * WHERE THE MONEY UNIT IS DECIDED
 *
 * Amounts arrive as decimal strings and stay decimal strings through canonicalisation, because the
 * hash must be reproducible by anyone holding the same declared rules. Parsing them into floats here
 * and re-serialising would make the hash depend on this runtime's formatting of a binary fraction,
 * which is a different value on a different host for the same user input.
 */

import type { PolicyRules } from "@untch/policy-engine";

export class PolicyShapeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyShapeError";
  }
}

/** What a person is actually asked. Everything else in `PolicyRules` is derived from these. */
export interface PolicyIntentInput {
  readonly name: string;
  /** The settlement token symbol these limits are denominated in. */
  readonly currency: string;
  /** Most this policy may authorise for ONE action. */
  readonly perActionLimit: string;
  /** Most this policy may authorise in a rolling day. */
  readonly dailyLimit: string;
  /** At or below this, a decision is automatic. Above it, the owner is asked. */
  readonly autoApproveAtOrBelow: string;
  /** The line nothing crosses, approval or not. */
  readonly hardCap: string;
  readonly allowedCapabilities: readonly string[];
  readonly deniedCapabilities?: readonly string[];
  readonly allowedProviders?: readonly string[];
  readonly deniedProviders?: readonly string[];
  readonly allowedRecipients?: readonly string[];
  readonly deniedRecipients?: readonly string[];
  /** ISO-8601. After this the policy authorises nothing, with no transaction needed to stop it. */
  readonly expiry: string;
  /** How long an identical action is treated as a duplicate. */
  readonly duplicateWindowMinutes?: number;
  /** Shortest gap between two calls to the same service. */
  readonly cooldownMinutes?: number;
  readonly callsPerHour?: number;
  /** How far a quote may drift from the estimate before the decision is re-taken. */
  readonly quoteTolerancePercent?: number;
  readonly escalationChannel?: string;
}

const AMOUNT_RE = /^\d{1,12}(\.\d{1,6})?$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function amount(value: unknown, field: string): string {
  if (typeof value === "number") {
    // Accepted for ergonomics, normalised immediately. A number that survived into the canonical
    // ruleset would make the hash depend on this runtime's float formatting.
    if (!Number.isFinite(value) || value < 0) {
      throw new PolicyShapeError("POLICY_AMOUNT_INVALID", `${field} must be a non-negative amount`);
    }
    return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value !== "string" || !AMOUNT_RE.test(value.trim())) {
    throw new PolicyShapeError(
      "POLICY_AMOUNT_INVALID",
      `${field} must be a decimal amount like "5.00" (up to 6 decimal places), received ${JSON.stringify(value)}`,
    );
  }
  return value.trim();
}

/** Compare two decimal strings without going through a float. */
function compare(a: string, b: string): number {
  const scale = (s: string): bigint => {
    const [whole, frac = ""] = s.split(".");
    return BigInt(`${whole}${frac.padEnd(6, "0")}`);
  };
  const x = scale(a);
  const y = scale(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function toNumber(s: string): number {
  return Number(s);
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new PolicyShapeError("POLICY_LIST_INVALID", `${field} must be an array of strings`);
  }
  return value as string[];
}

function addresses(value: unknown, field: string): string[] {
  return strings(value, field).map((v) => {
    if (!ADDRESS_RE.test(v)) {
      throw new PolicyShapeError("POLICY_ADDRESS_INVALID", `${field} contains ${v}, which is not a 20-byte address`);
    }
    // Lowercased so two spellings of one recipient are one entry in the hashed ruleset.
    return v.toLowerCase();
  });
}

export interface DerivedPolicy {
  readonly rules: PolicyRules;
  /** What the derivation decided that the caller did not state. Shown, never hidden. */
  readonly derived: readonly { readonly field: string; readonly value: string; readonly because: string }[];
}

/**
 * Translate, refusing rather than repairing.
 *
 * Every refusal below is a ruleset that would have been ACCEPTED by `parsePolicyRules` and then
 * behaved in a way the person who wrote it did not intend — an auto-approval threshold above the hard
 * cap makes the cap unreachable, a per-action limit above the daily limit means the day's budget is
 * spent by one call. The validator downstream checks shapes; these are the checks about MEANING, and
 * they belong where the human's words are still available to quote back.
 */
export function derivePolicyRules(input: PolicyIntentInput): DerivedPolicy {
  const perAction = amount(input.perActionLimit, "perActionLimit");
  const daily = amount(input.dailyLimit, "dailyLimit");
  const autoApprove = amount(input.autoApproveAtOrBelow, "autoApproveAtOrBelow");
  const hardCap = amount(input.hardCap, "hardCap");

  if (typeof input.currency !== "string" || input.currency.trim() === "") {
    throw new PolicyShapeError("POLICY_CURRENCY_REQUIRED", "currency is required, e.g. \"USDC\"");
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new PolicyShapeError("POLICY_NAME_REQUIRED", "name is required");
  }

  const expiryMs = Date.parse(input.expiry ?? "");
  if (Number.isNaN(expiryMs)) {
    throw new PolicyShapeError("POLICY_EXPIRY_INVALID", "expiry must be a parseable ISO-8601 instant");
  }
  if (expiryMs <= Date.now()) {
    // The registry refuses this too, on chain, with gas already spent. Refusing here costs nothing.
    throw new PolicyShapeError("POLICY_EXPIRY_PAST", "expiry is in the past; the registry would refuse to register it");
  }

  if (compare(autoApprove, hardCap) > 0) {
    throw new PolicyShapeError(
      "POLICY_THRESHOLD_ABOVE_CAP",
      `autoApproveAtOrBelow (${autoApprove}) is above hardCap (${hardCap}), which would make the cap ` +
        "unreachable: every action under the cap would approve without ever being asked about",
    );
  }
  if (compare(perAction, hardCap) > 0) {
    throw new PolicyShapeError(
      "POLICY_PER_ACTION_ABOVE_CAP",
      `perActionLimit (${perAction}) is above hardCap (${hardCap}); the cap is the line nothing crosses`,
    );
  }
  if (compare(perAction, daily) > 0) {
    throw new PolicyShapeError(
      "POLICY_PER_ACTION_ABOVE_DAILY",
      `perActionLimit (${perAction}) is above dailyLimit (${daily}); one action would spend the whole day`,
    );
  }

  const allow = strings(input.allowedCapabilities, "allowedCapabilities");
  if (allow.length === 0) {
    throw new PolicyShapeError(
      "POLICY_NO_CAPABILITIES",
      "allowedCapabilities must name at least one capability; a policy that permits nothing is a policy " +
        "whose every decision is a refusal, which is better expressed by not having one",
    );
  }

  const duplicateWindow = input.duplicateWindowMinutes ?? 60;
  const cooldown = input.cooldownMinutes ?? 0;
  const callsPerHour = input.callsPerHour ?? 60;
  const quoteTolerance = input.quoteTolerancePercent ?? 5;

  const derived: DerivedPolicy["derived"] = [
    {
      field: "duplicates.ttlMin",
      value: String(duplicateWindow),
      because: "how long an identical action counts as a repeat. Not stated, so one hour is assumed.",
    },
    {
      field: "rateLimit.callsPerHour",
      value: String(callsPerHour),
      because: "a ceiling on call volume independent of amount. Not stated, so 60 per hour is assumed.",
    },
    {
      field: "cooldowns.sameServiceMin",
      value: String(cooldown),
      because: "shortest gap between two calls to the same service. Not stated, so no cooldown.",
    },
    {
      field: "onPerCallCapExceeded",
      value: "ESCALATE",
      because:
        "what happens when one action exceeds the per-action limit. ESCALATE asks you; BLOCK refuses " +
        "outright. Asking is the reversible one, so it is the default.",
    },
    {
      field: "quoteTolerancePercent",
      value: String(quoteTolerance),
      because: "how far a quote may drift from the estimate before the decision is re-taken.",
    },
  ];

  const rules = {
    version: 1,
    name: input.name.trim(),
    expiry: new Date(expiryMs).toISOString(),
    budgets: {
      daily: toNumber(daily),
      token: input.currency.trim(),
    },
    perCallCap: toNumber(perAction),
    // A per-action limit that is exceeded ASKS rather than refuses. Both are defensible; asking is
    // the one that can be undone by a human in the next thirty seconds.
    onPerCallCapExceeded: "ESCALATE" as const,
    escalateAbove: toNumber(autoApprove),
    hardCap: toNumber(hardCap),
    categories: {
      allow,
      deny: strings(input.deniedCapabilities, "deniedCapabilities"),
    },
    providers: {
      allow: strings(input.allowedProviders, "allowedProviders"),
      deny: strings(input.deniedProviders, "deniedProviders"),
    },
    recipients: {
      allow: addresses(input.allowedRecipients, "allowedRecipients"),
      deny: addresses(input.deniedRecipients, "deniedRecipients"),
    },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: duplicateWindow, keys: ["provider", "capability", "amount", "recipient"] },
    cooldowns: { sameServiceMin: cooldown },
    rateLimit: { callsPerHour },
    quote: { tolerancePercent: quoteTolerance },
    ...(input.escalationChannel ? { escalation: { preferredChannel: input.escalationChannel } } : {}),
  } as unknown as PolicyRules;

  return { rules, derived };
}

/**
 * The same rules, back in the words the person used.
 *
 * A policy detail view that showed only the canonical ruleset would be honest and unreadable. This is
 * the readable half, and it is DERIVED from the stored rules rather than stored alongside them — a
 * second copy would be a second thing that can drift from what the chain actually committed to.
 */
export function summarisePolicyRules(rules: Record<string, unknown>): Record<string, unknown> {
  const budgets = (rules.budgets ?? {}) as Record<string, unknown>;
  const categories = (rules.categories ?? {}) as Record<string, unknown>;
  const recipients = (rules.recipients ?? {}) as Record<string, unknown>;
  const duplicates = (rules.duplicates ?? {}) as Record<string, unknown>;
  const rateLimit = (rules.rateLimit ?? {}) as Record<string, unknown>;
  const cooldowns = (rules.cooldowns ?? {}) as Record<string, unknown>;

  return {
    name: rules.name ?? null,
    currency: budgets.token ?? null,
    perActionLimit: rules.perCallCap ?? null,
    dailyLimit: budgets.daily ?? null,
    autoApproveAtOrBelow: rules.escalateAbove ?? null,
    hardCap: rules.hardCap ?? null,
    allowedCapabilities: categories.allow ?? [],
    deniedCapabilities: categories.deny ?? [],
    allowedRecipients: recipients.allow ?? [],
    deniedRecipients: recipients.deny ?? [],
    duplicateWindowMinutes: duplicates.ttlMin ?? null,
    cooldownMinutes: cooldowns.sameServiceMin ?? null,
    callsPerHour: rateLimit.callsPerHour ?? null,
    expiry: rules.expiry ?? null,
    onPerCallCapExceeded: rules.onPerCallCapExceeded ?? null,
    readable: [
      `Up to ${rules.perCallCap ?? "?"} ${budgets.token ?? ""} per action.`,
      `Up to ${budgets.daily ?? "?"} ${budgets.token ?? ""} per day.`,
      `At or below ${rules.escalateAbove ?? "?"} ${budgets.token ?? ""} decides automatically; above it, you are asked.`,
      `Nothing above ${rules.hardCap ?? "?"} ${budgets.token ?? ""}, approved or not.`,
      `Permitted: ${(categories.allow as string[] | undefined)?.join(", ") || "nothing"}.`,
      `Stops authorising anything after ${rules.expiry ?? "?"}.`,
    ],
  };
}
