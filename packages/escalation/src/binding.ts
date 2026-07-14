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

/**
 * Dashboard's interim binding: the operator's SIWE-verified wallet address on the `dashboard` channel.
 * Same one demo operator as the other three, reached on their own authenticated dashboard session, NOT a
 * second approver. The real self-serve binding flow (§15) is the named future step; until then it is the
 * one configured operator wallet.
 *
 * Compared CASE-INSENSITIVELY, unlike the exact-match handle binding above: an EVM address is the same
 * address regardless of EIP-55 checksum casing, so a session presenting the lowercased form must match a
 * configured mixed-case (or all-caps) wallet, and vice versa. Any other address is unbound ⇒ IGNORED_UNBOUND.
 */
export function interimDashboardBinding(walletAddress: string): BindingVerifier {
  const boundHandle = walletAddress.trim().toLowerCase();
  return (ch, senderHandle) =>
    ch === "dashboard" && senderHandle.trim().toLowerCase() === boundHandle;
}

/**
 * Photon's interim binding: the bound operator's iMessage handle on the `imessage` channel. Same one demo
 * operator as the other four surfaces — one person reached on iMessage, not a fifth approver. Any other
 * sender handle is unbound ⇒ IGNORED_UNBOUND.
 *
 * Compared CASE-INSENSITIVELY: an email iMessage handle is the same regardless of case, and Apple may
 * return a differently-cased form than the configured one, so a plain exact match would wrongly reject a
 * legitimate reply. E.164 phone handles are digits and unaffected. The real §15 onboarding binding is the
 * named future step; until then it is the one configured operator handle.
 */
export function interimPhotonBinding(handle: string): BindingVerifier {
  const boundHandle = handle.trim().toLowerCase();
  return (ch, senderHandle) => ch === "imessage" && senderHandle.trim().toLowerCase() === boundHandle;
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
