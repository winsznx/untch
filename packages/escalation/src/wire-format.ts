import type { EscalationMessage, GovernanceAlert } from "./channel";

/**
 * The transport-neutral §27 approval wire format, shared by every real channel.
 *
 * Two ways an operator answers, both channel-agnostic:
 *   • a BUTTON whose payload is `a:<escId>:<code>` / `d:<escId>:<code>` (Telegram inline button, Discord
 *     component custom_id, Slack block-action value) — the id lets the service resolve directly, and the
 *     code is still re-validated (§27 pt4);
 *   • the bare TEXT baseline `APPROVE <code>` / `DENY <code>` (the judge-safe path — needs nothing beyond
 *     send/receive), resolved by the code's hash.
 *
 * Every channel normalizes its native event into these, then the service runs the SAME authority-boundary
 * check regardless of origin. Keeping the format here (not inside one channel) is what lets Discord and
 * Slack reuse Telegram's exact reply grammar without re-implementing it.
 */

export interface ParsedCommand {
  readonly action: "APPROVE" | "DENY";
  readonly code: string;
  readonly escalationRef?: string;
}

/** `a:<escId>:<code>` (approve) / `d:<escId>:<code>` (deny) — the button payload every channel emits. */
export function parseButtonPayload(data: string | undefined): ParsedCommand | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [tag, escalationRef, code] = parts;
  if (!escalationRef || !code) return null;
  if (tag === "a") return { action: "APPROVE", code, escalationRef };
  if (tag === "d") return { action: "DENY", code, escalationRef };
  return null;
}

/** `APPROVE <code>` / `DENY <code>` (§27 text baseline). Case-insensitive; no id, resolved by hash. */
export function parseTextCommand(text: string): ParsedCommand | null {
  const m = text.trim().match(/^(approve|deny)\s+([0-9a-fA-F]{8,})$/i);
  if (!m) return null;
  return {
    action: m[1]!.toUpperCase() === "APPROVE" ? "APPROVE" : "DENY",
    code: m[2]!,
  };
}

/** The button payloads for one escalation, in the shared format. */
export function approvePayload(m: EscalationMessage): string {
  return `a:${m.escalationId}:${m.code}`;
}
export function denyPayload(m: EscalationMessage): string {
  return `d:${m.escalationId}:${m.code}`;
}

/**
 * The escalation message copy — one plain-text body every channel sends, because a real operator reads
 * the same words whether it lands in Telegram, Discord, or Slack. Plain everyday language, no em-dashes,
 * no filler: what the agent wants to spend, why it was held, and the one action being asked for.
 */
export function renderApprovalText(m: EscalationMessage): string {
  const deadline = new Date(m.expiresAt).toISOString().replace("T", " ").slice(0, 19);
  return [
    `The agent wants to spend ${m.amount} ${m.token}. Untch held it and needs your OK.`,
    ``,
    `Reason: ${m.reason}`,
    `Policy: ${m.policyId}`,
    `Intent: ${m.intentId}`,
    ``,
    `Approve or deny below. This expires at ${deadline} UTC. If you do not answer, it is denied.`,
  ].join("\n");
}

/** Plain-language headline per event kind. What a woken operator reads first. */
function governanceHeadline(a: GovernanceAlert): string {
  switch (a.kind) {
    case "OpProposed":
      return `Someone proposed a change to ${a.contract}. You have time to cancel it.`;
    case "OpExecuted":
      return `A proposed change to ${a.contract} just took effect.`;
    case "OpCancelled":
      return `A pending change to ${a.contract} was cancelled.`;
    case "WriterAdded":
      return `A new writer can now write to ${a.contract}.`;
    case "WriterRemoved":
      return `A writer lost access to ${a.contract}.`;
    case "AdminTransferred":
      return `${a.contract} has a new admin.`;
    case "OracleChanged":
      return `${a.contract} has a new oracle key. It signs spend authorizations.`;
    case "OwnershipTransferStarted":
      return `Someone started handing over ownership of ${a.contract}.`;
    case "OwnershipTransferred":
      return `${a.contract} has a new owner. The owner controls the funds.`;
    case "Paused":
      return `${a.contract} was paused.`;
    case "Unpaused":
      return `${a.contract} was unpaused. It can move funds again.`;
  }
}

/**
 * The governance alert copy — the notification twin of `renderApprovalText`, same plain-language rule,
 * and deliberately with NO approve/deny grammar. The only lever an operator has here is an on-chain
 * `cancel()` from the admin key, so the text says exactly that rather than implying a reply does anything.
 */
export function renderGovernanceText(a: GovernanceAlert): string {
  const lines = [governanceHeadline(a), ``];

  for (const [k, v] of Object.entries(a.fields)) lines.push(`${k}: ${v}`);

  lines.push(``, `Contract: ${a.contract} ${a.contractAddress} (chain ${a.chainId})`, `Tx: ${a.txHash}`);
  if (a.explorerUrl) lines.push(a.explorerUrl);

  if (a.cancelWindow) {
    const hrs = Math.floor(a.cancelWindow.secondsRemaining / 3600);
    const mins = Math.floor((a.cancelWindow.secondsRemaining % 3600) / 60);
    const left = a.cancelWindow.secondsRemaining <= 0 ? "it can be executed NOW" : `about ${hrs}h ${mins}m left`;
    lines.push(
      ``,
      `This cannot take effect until ${a.cancelWindow.etaIso.replace("T", " ").slice(0, 19)} UTC (${left}).`,
      `If you did not expect this, cancel it on-chain with the admin key before then:`,
      `  cancel(kind, target) on ${a.contractAddress}`,
      `Replying here does nothing. Cancelling is an on-chain admin call.`,
    );
  }
  return lines.join("\n");
}
