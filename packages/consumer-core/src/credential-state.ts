/**
 * Which credentials this deployment is willing to USE, as distinct from which it happens to hold.
 *
 * WHAT HAPPENED
 *
 * A cold audit found that Railway tooling had exposed production credentials — channel tokens among
 * them. The tokens still work. That is the problem: "still works" is precisely why a compromised
 * credential keeps getting used, and why the failure is silent. Nothing in the code knew the difference
 * between a token that was configured and a token that was safe.
 *
 * WHAT THIS ADDS
 *
 * A second fact per credential, held OUTSIDE the credential itself: is this value the one the audit saw,
 * or a replacement. `UNTCH_ROTATED_CREDENTIALS` names the ones that have been genuinely rotated; every
 * other configured credential is treated as `CURRENT_UNROTATED` and the adapter that would use it is
 * refused. Not warned about — refused, with the refusal recorded as a SKIPPED delivery, so an approval
 * that went unanswered because nobody was told reads differently from one the owner ignored.
 *
 * WHY THE DEFAULT IS "UNROTATED"
 *
 * Because the alternative fails open. If the absence of an entry meant "fine", then the state after a
 * fresh deploy, a lost variable, or a typo in the list would be "send with the exposed token" — the
 * exact behaviour the gate exists to prevent, reached by doing nothing. Requiring a positive assertion
 * means the safe state is the one you get when you have not thought about it yet.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not read, log, hash or compare any secret VALUE. It only ever reports whether a name is
 * present in the environment and whether that name appears in the rotated list, so nothing here can
 * leak a token into a log, a snapshot or a test fixture — and nothing here can be fooled by a token
 * that was rotated to the same value, which is not a case worth defending against with a mechanism that
 * would have to handle the secret to detect it.
 */

export type CredentialState = "ABSENT" | "CURRENT_UNROTATED" | "ROTATED";

export interface CredentialReport {
  /** The environment variable's name. Never its value, anywhere, ever. */
  readonly name: string;
  readonly state: CredentialState;
  /** What stops working while this is unrotated. Written for whoever reads the boot log. */
  readonly blocks: string;
}

/**
 * Credentials the audit reached, in the order they should be rotated.
 *
 * Order is not arbitrary. The channel tokens come first because they are the ones a new feature wants
 * to switch on and the ones whose misuse is loudest but least destructive. The chain keys come last
 * because rotating one changes an on-chain ADDRESS, which means a contract's authorised-writer set has
 * to change with it — a governance operation with a timelock, not a variable update.
 */
export const AUDITED_CREDENTIALS: readonly { readonly name: string; readonly blocks: string; readonly changesOnchainAddress: boolean }[] = [
  { name: "TELEGRAM_BOT_TOKEN", blocks: "Telegram approval delivery and inbound callbacks", changesOnchainAddress: false },
  { name: "DISCORD_BOT_TOKEN", blocks: "Discord approval delivery and inbound interactions", changesOnchainAddress: false },
  { name: "SLACK_BOT_TOKEN", blocks: "Slack approval delivery", changesOnchainAddress: false },
  { name: "SLACK_APP_TOKEN", blocks: "Slack socket-mode inbound", changesOnchainAddress: false },
  { name: "OKX_API_KEY", blocks: "x402 facilitator settlement", changesOnchainAddress: false },
  { name: "OKX_SECRET_KEY", blocks: "x402 facilitator settlement", changesOnchainAddress: false },
  { name: "OKX_PASSPHRASE", blocks: "x402 facilitator settlement", changesOnchainAddress: false },
  { name: "INTERNAL_OPS_TOKEN", blocks: "operator control surface and deployment-info", changesOnchainAddress: false },
  { name: "CONSUMER_AUTH_SECRET", blocks: "every session token this host has ever minted", changesOnchainAddress: false },
  { name: "DATABASE_URL", blocks: "all durable state", changesOnchainAddress: false },
  { name: "REDIS_URL", blocks: "queues and rate limiting", changesOnchainAddress: false },
  { name: "GROQ_API_KEY", blocks: "Launch Pack naming", changesOnchainAddress: false },
  // Below this line, rotation moves an ADDRESS. A new key is a new signer, and every contract that
  // authorised the old one has to be told — which is a timelocked governance operation, not a deploy.
  { name: "OPERATOR_PRIVATE_KEY", blocks: "policy update/pause/resume signing", changesOnchainAddress: true },
  { name: "ORACLE_PRIVATE_KEY", blocks: "oracle attestation signing", changesOnchainAddress: true },
  { name: "INTENT_WRITER_PRIVATE_KEY", blocks: "intent and receipt anchoring", changesOnchainAddress: true },
  { name: "CONSUMER_TREASURY_BASE_PRIVATE_KEY", blocks: "Base treasury settlement", changesOnchainAddress: true },
];

function rotatedSet(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env.UNTCH_ROTATED_CREDENTIALS?.trim() ?? "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function credentialState(name: string, env: NodeJS.ProcessEnv = process.env): CredentialState {
  const present = (env[name]?.trim() ?? "") !== "";
  if (!present) return "ABSENT";
  return rotatedSet(env).has(name) ? "ROTATED" : "CURRENT_UNROTATED";
}

/**
 * May a channel adapter SEND?
 *
 * Absent is a refusal too, and for a different reason worth keeping distinct: an absent credential is a
 * channel nobody configured, an unrotated one is a channel somebody configured with a value the audit
 * saw. Both refuse; only one of them is a surprise.
 */
export function channelSendAllowed(
  channel: "telegram" | "discord" | "slack" | "email",
  env: NodeJS.ProcessEnv = process.env,
): { readonly allowed: boolean; readonly state: CredentialState; readonly reason: string } {
  const name = {
    telegram: "TELEGRAM_BOT_TOKEN",
    discord: "DISCORD_BOT_TOKEN",
    slack: "SLACK_BOT_TOKEN",
    // Email carries a link to an authenticated session and never an answer, so its credential gates
    // delivery only. It is listed here so the same gate covers it rather than it becoming the one
    // channel that ships without passing through this function.
    email: "STABLEEMAIL_API_KEY",
  }[channel];

  const state = credentialState(name, env);
  if (state === "ROTATED") {
    return { allowed: true, state, reason: `${name} is marked rotated` };
  }
  if (state === "ABSENT") {
    return { allowed: false, state, reason: `${name} is not configured on this deployment` };
  }
  return {
    allowed: false,
    state,
    reason:
      `${name} is present but has not been marked rotated. The cold audit reported production ` +
      "credentials exposed through Railway tooling; a token that still works is exactly the one that " +
      `keeps getting used. Rotate it, then add ${name} to UNTCH_ROTATED_CREDENTIALS.`,
  };
}

export function credentialReport(env: NodeJS.ProcessEnv = process.env): readonly CredentialReport[] {
  return AUDITED_CREDENTIALS.map((c) => ({
    name: c.name,
    state: credentialState(c.name, env),
    blocks: c.blocks,
  }));
}

/**
 * The ordered maintenance window, as a plan rather than a paragraph.
 *
 * Split at the point where rotation stops being a variable update. Everything in `phase1` can be
 * rotated by changing a value and redeploying. Everything in `phase2` produces a new ADDRESS, so the
 * contracts that authorised the old one must be updated — which on this system means a timelocked
 * governance operation, executed separately and never as part of a deploy.
 */
export function rotationPlan(env: NodeJS.ProcessEnv = process.env): {
  readonly phase1: readonly CredentialReport[];
  readonly phase2: readonly CredentialReport[];
  readonly outstanding: number;
} {
  const report = credentialReport(env);
  const byName = new Map(AUDITED_CREDENTIALS.map((c) => [c.name, c]));
  const phase1 = report.filter((r) => !byName.get(r.name)?.changesOnchainAddress);
  const phase2 = report.filter((r) => byName.get(r.name)?.changesOnchainAddress);
  return {
    phase1,
    phase2,
    outstanding: report.filter((r) => r.state === "CURRENT_UNROTATED").length,
  };
}
