import type { StoredPolicy } from "@untch/policy-store";
import type { ApprovalsConfig } from "./types";

/**
 * Read the §27 approvals config out of a stored policy.
 *
 * `StoredPolicy.rules` is typed as the engine's narrowed `PolicyRules`, but the store keeps the ORIGINAL
 * submitted object verbatim in JSONB (policy-store `parsePolicyRules` returns `r as PolicyRules` without
 * rebuilding), so the §8 `approvals` block and `escalationTimeoutMin` are actually present at runtime —
 * they were just dropped from the compile-time type. This reader crosses that boundary once, safely:
 * every field is validated, and anything malformed falls back to a fail-closed default rather than
 * throwing (a policy that can't express its approvals config must not become un-escalatable — it
 * degrades to "single live channel, no dual-channel requirement, default timeout").
 *
 * Fail-closed defaults:
 *   • channels: []          — the service treats an empty allow-list as "the caller's live channels"
 *                             (with only Telegram live, that is Telegram). Never implicitly widens.
 *   • dualChannelAbove: null— never require a second channel unless the policy explicitly asks.
 *   • channelCaps: {}       — a channel with no configured cap is uncapped by policy (the amount was
 *                             already escalated by the engine; the cap is an extra per-channel ceiling).
 *   • escalationTimeoutMin: null — caller applies its configured default (§7.2 default 30).
 */
export function readApprovalsConfig(policy: StoredPolicy): ApprovalsConfig {
  const rules = policy.rules as unknown as Record<string, unknown>;
  const approvals = isObject(rules.approvals) ? rules.approvals : {};

  return {
    channels: readStringArray(approvals.channels),
    dualChannelAbove: readPositiveNumber(approvals.dualChannelAbove),
    channelCaps: readNumberMap(approvals.channelCaps),
    escalationTimeoutMin: readPositiveNumber(rules.escalationTimeoutMin),
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function readStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function readPositiveNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
}

function readNumberMap(x: unknown): Record<string, number> {
  if (!isObject(x)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}
