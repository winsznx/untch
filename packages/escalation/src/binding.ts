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
  const bound = chatId.trim();
  return (channel, senderHandle) => channel === "telegram" && senderHandle.trim() === bound;
}

/** Combine per-channel verifiers (a bound approval on ANY of them passes). Ready for a second channel. */
export function combineBindings(...verifiers: BindingVerifier[]): BindingVerifier {
  return (channel, senderHandle) => verifiers.some((v) => v(channel, senderHandle));
}
