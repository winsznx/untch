import type { BindingVerifier } from "./service";

/**
 * Handle-binding — the §27 pt3 tuple check (which handle belongs to which operator).
 *
 * INTERIM (see README → "Handle-binding interim"): there is no onboarding/binding UI yet — no dashboard
 * exists — so the real binding tuple (channel + provider + spaceId/conversation + sender handle +
 * verified operator wallet + last-verified-at, established by a code roundtrip) is not yet capturable.
 * Until it is, this is a single configured Telegram chat id bound to the one demo operator this whole
 * build has used (the Step-5 demo wallet). It is clearly temporary. The REAL requirement — a proper
 * onboarding/binding flow driven from the dashboard (§15) — is a named future step, not silently absent.
 *
 * The check is intentionally strict: only the exact bound chat id on the `telegram` channel matches.
 * A plausible-looking approval from any other chat id is unbound ⇒ IGNORED_UNBOUND.
 */
export function interimTelegramBinding(chatId: string): BindingVerifier {
  return interimHandleBinding("telegram", chatId);
}

/**
 * Discord's interim binding: the exact bound Discord user id on the `discord` channel. Same one demo
 * operator as Telegram — one person reachable on another surface, not a different approver. Any other
 * sender id is unbound ⇒ IGNORED_UNBOUND.
 */
export function interimDiscordBinding(userId: string): BindingVerifier {
  return interimHandleBinding("discord", userId);
}

/**
 * Slack's interim binding: the exact bound Slack user id on the `slack` channel. Same bound operator as
 * the other two channels. Any other sender id is unbound ⇒ IGNORED_UNBOUND.
 */
export function interimSlackBinding(userId: string): BindingVerifier {
  return interimHandleBinding("slack", userId);
}

/** One strict channel+handle binding — the shared interim shape until the real §15 onboarding flow exists. */
function interimHandleBinding(channel: string, handle: string): BindingVerifier {
  const boundChannel = channel;
  const boundHandle = handle.trim();
  return (ch, senderHandle) => ch === boundChannel && senderHandle.trim() === boundHandle;
}

/**
 * Combine per-channel verifiers: a bound approval on ANY of them passes. This is what turns the three
 * single-channel bindings into "one operator, three reachable surfaces" — each verifier only matches its
 * own channel's bound handle, so combining them authorizes the same operator across Telegram, Discord, and
 * Slack while still rejecting an unbound sender on any of them.
 */
export function combineBindings(...verifiers: BindingVerifier[]): BindingVerifier {
  return (channel, senderHandle) => verifiers.some((v) => v(channel, senderHandle));
}
