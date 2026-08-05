import { createHash } from "node:crypto";
import {
  ensureActionReferences,
  ensureWebApprovalBinding,
  type ChannelGateway,
  type DeliveryTarget,
  type Pool,
  type SendOutcome,
} from "@untch/consumer-core";
import { actionUrls } from "./approval-action-routes";

/**
 * The message a person actually reads, and the two links that are the only way to answer it.
 *
 * WHAT THE MESSAGE HAS TO SAY, AND WHY EACH FIELD IS THERE
 *
 * A person approving a payment is being asked to take responsibility for it. "Approve request
 * aprq_9f2c?" asks them to take responsibility for an opaque identifier. So the message states the
 * obligation in full: who is being paid, for what, how much, under which policy, and when both clocks
 * run out. If any of that were missing, the honest description of the interaction would be that
 * somebody clicked a button.
 *
 * WHAT THE LINKS CARRY
 *
 * An opaque reference and nothing else. Not the token, not the digest, not the amount, not the account
 * id. Discord unfurls links and people forward messages, so anything in a URL is effectively public.
 *
 * WHY THE WEB PROJECTION IS CREATED HERE TOO
 *
 * The same outbox event produces both. A person who misses the Discord message must be able to answer
 * from the dashboard, and a second code path that created the web side separately would eventually
 * create one without the other. Both surfaces resolve through the same references and the same
 * terminal function, so "Discord and web converge" is a property of there being one implementation.
 */

export interface DiscordApprovalGatewayDeps {
  readonly pool: Pool;
  readonly publicBaseUrl: string;
  /** The bot token. Absent means this deployment cannot send, and the gateway says so rather than pretending. */
  readonly botToken: string | null;
  /** Injected so a test can assert the exact body without a network. */
  readonly post?: (url: string, body: unknown, token: string) => Promise<{ ok: boolean; id: string | null; status: number }>;
  readonly now?: () => number;
  /**
   * Structured delivery logging, off unless a caller wires it.
   *
   * The 404 that cost a fee was invisible until the row was read out of the database by hand: the
   * worker logged a count and the gateway logged nothing at all. Every field it emits is a
   * fingerprint, so a delivery can be followed end to end without a Discord id appearing in a log.
   */
  readonly log?: (line: string) => void;
}

interface MessageFacts {
  readonly provider: string;
  readonly capability: string;
  readonly amount: string;
  readonly asset: string;
  readonly recipient: string | null;
  readonly policyId: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly accountId: string;
  readonly accountRefHash: string;
  readonly approvalDigest: string;
}

async function factsFor(pool: Pool, approvalRequestId: string): Promise<MessageFacts | null> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT provider, capability, amount, asset, recipient, policy_id, state, expires_at,
            account_id, account_ref_hash, approval_digest
       FROM untch_approval_requests WHERE approval_request_id = $1`,
    [approvalRequestId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    provider: String(r.provider),
    capability: String(r.capability),
    amount: String(r.amount),
    asset: String(r.asset),
    recipient: r.recipient === null ? null : String(r.recipient),
    policyId: String(r.policy_id),
    state: String(r.state),
    expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
    accountId: String(r.account_id),
    accountRefHash: String(r.account_ref_hash ?? ""),
    approvalDigest: String(r.approval_digest),
  };
}

/**
 * The recipient, shown truncated.
 *
 * Enough to check against what was expected, and not a full address pasted into a chat log that will
 * outlive the decision. A null recipient is NAMED rather than shown blank, because "no recipient" and
 * "we could not work out the recipient" are different facts and only one of them is fine.
 */
function safeRecipient(recipient: string | null): string {
  if (recipient === null) return "none (resolved at execution)";
  return `${recipient.slice(0, 10)}…${recipient.slice(-8)}`;
}

export function renderApprovalMessage(args: {
  readonly facts: MessageFacts;
  readonly approveUrl: string;
  readonly denyUrl: string;
  readonly requestExpiresAt: string;
  readonly approvalExpiresAt: string;
}): Record<string, unknown> {
  const f = args.facts;
  return {
    // Plain content as well as the embed, because a notification preview shows the content line and a
    // person should be able to see the amount without opening the app.
    content: `Approval needed: ${f.amount} ${f.asset} to ${f.provider}/${f.capability}`,
    embeds: [
      {
        title: `Approve ${f.amount} ${f.asset}?`,
        description:
          "Approving reserves this amount as authority under your policy. It moves no money and runs " +
          "no provider. Denying records a refusal and creates no authority.",
        fields: [
          { name: "Provider", value: f.provider, inline: true },
          { name: "Capability", value: f.capability, inline: true },
          { name: "Amount", value: `${f.amount} ${f.asset}`, inline: true },
          { name: "Recipient", value: safeRecipient(f.recipient), inline: false },
          { name: "Policy", value: f.policyId, inline: true },
          { name: "Status", value: f.state, inline: true },
          { name: "Request expires", value: args.requestExpiresAt, inline: false },
          { name: "Approval expires", value: args.approvalExpiresAt, inline: false },
        ],
      },
    ],
    components: [
      {
        type: 1,
        components: [
          /**
           * Link buttons, not interaction buttons.
           *
           * An interaction button would need a Discord Interactions Endpoint, which is new developer-
           * console configuration. A link button opens the action URL, where the person is
           * re-authenticated through the OAuth application that already exists. The security property
           * is identical because the link decides nothing: it leads to a login and then a POST.
           */
          { type: 2, style: 5, label: `Approve ${f.amount} ${f.asset}`, url: args.approveUrl },
          { type: 2, style: 5, label: "Deny", url: args.denyUrl },
        ],
      },
    ],
  };
}

const defaultPost = async (
  url: string,
  body: unknown,
  token: string,
): Promise<{ ok: boolean; id: string | null; status: number }> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let id: string | null = null;
  try {
    const parsed = (await res.json()) as { id?: unknown };
    id = typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    id = null;
  }
  return { ok: res.ok, id, status: res.status };
};

/**
 * The gateway the delivery worker calls.
 *
 * It mints the action references in their own transaction BEFORE sending, so a message can never carry
 * a link that does not resolve. If the send then fails, the references stay live and the retry reuses
 * them rather than minting a second pressable pair.
 */
export function discordApprovalGateway(deps: DiscordApprovalGatewayDeps): ChannelGateway {
  const post = deps.post ?? defaultPost;

  return {
    async send(target: DeliveryTarget): Promise<SendOutcome> {
      if (!deps.botToken) {
        /**
         * Retryable, and explicitly NOT ok. A gateway that returned success without sending would mark
         * the delivery SENT and leave a person waiting for a message nobody wrote.
         */
        return { ok: false, retryable: true, failureCode: "DISCORD_BOT_TOKEN_ABSENT" };
      }
      if (target.channel !== "discord") {
        /**
         * The web projection is a delivery row that represents the dashboard, not something to send to.
         * It is marked sent because the thing it stands for — an answerable surface — genuinely exists
         * the moment the references do.
         */
        return { ok: true, externalDeliveryId: `web:${target.approvalRequestId}` };
      }

      const facts = await factsFor(deps.pool, target.approvalRequestId);
      if (!facts) return { ok: false, retryable: false, failureCode: "APPROVAL_REQUEST_GONE" };

      const client = await deps.pool.connect();
      let refs: { APPROVE: string; DENY: string };
      try {
        await client.query("BEGIN");
        refs = await ensureActionReferences(client as never, {
          approvalRequestId: target.approvalRequestId,
          accountId: facts.accountId,
          accountRefHash: facts.accountRefHash,
          channelBindingId: target.channelBindingId,
          approvalDigest: facts.approvalDigest,
          expiresAt: facts.expiresAt,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        return { ok: false, retryable: true, failureCode: `ACTION_REF_FAILED: ${(err as Error).message.slice(0, 80)}` };
      } finally {
        client.release();
      }

      const urls = actionUrls(deps.publicBaseUrl, refs);
      const body = renderApprovalMessage({
        facts,
        approveUrl: urls.approve,
        denyUrl: urls.deny,
        requestExpiresAt: facts.expiresAt,
        approvalExpiresAt: facts.expiresAt,
      });

      /**
       * A direct message needs a DM channel; a guild message needs the channel id the binding recorded.
       *
       * WHY THIS IS A FUNCTION AND NOT `if (!channelChatId)`
       *
       * It was that, and a binding whose `channel_chat_id` held the Discord USER id took the guild
       * branch and POSTed to `/channels/<user id>/messages`. That is not a channel, Discord answered
       * 404 terminally, and a paid approval reached nobody. The link flow no longer writes that value,
       * but a guard that only trusts the fix is a guard that trusts one row's history — so the shape
       * is checked here too, where the request is actually made.
       */
      const route = discordDeliveryRoute(target);
      const log = (stage: string, extra: Record<string, unknown>): void => {
        deps.log?.(
          `[discord-approval] ${JSON.stringify({
            stage,
            binding: fingerprint(target.channelBindingId),
            userTarget: fingerprint(target.channelUserId),
            approvalRequest: fingerprint(target.approvalRequestId),
            mode: route.mode,
            ...extra,
          })}`,
        );
      };

      let channelId: string;
      if (route.mode === "dm") {
        const dm = await post("https://discord.com/api/v10/users/@me/channels", { recipient_id: target.channelUserId }, deps.botToken);
        log("dm-open", { status: dm.status, ok: dm.ok, dmChannel: dm.id ? fingerprint(dm.id) : null, reason: route.reason });
        if (!dm.ok || !dm.id) {
          return { ok: false, retryable: dm.status >= 500 || dm.status === 429, failureCode: `DISCORD_DM_OPEN_${dm.status}` };
        }
        channelId = dm.id;
      } else {
        channelId = route.channelId;
      }

      const sent = await post(`https://discord.com/api/v10/channels/${channelId}/messages`, body, deps.botToken);
      log("send", { status: sent.status, ok: sent.ok, externalMessage: sent.id ? fingerprint(sent.id) : null });
      return sent.ok
        ? { ok: true, externalDeliveryId: sent.id }
        : { ok: false, retryable: sent.status >= 500 || sent.status === 429, failureCode: `DISCORD_SEND_${sent.status}` };
    },
  };
}

/**
 * A short, non-reversing fingerprint for a Discord identifier.
 *
 * Logs have to be joinable across a delivery without becoming a place someone reads a user's Discord
 * id out of. Truncated SHA-256 gives the join and not the value.
 */
function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export type DiscordDeliveryRoute =
  | { readonly mode: "dm"; readonly reason: string }
  | { readonly mode: "channel"; readonly channelId: string };

/**
 * Where a Discord approval message is actually sent, decided from the binding rather than assumed.
 *
 * A DM whenever there is no INDEPENDENTLY VERIFIED channel to use. That covers the null and empty
 * cases, the case where the recorded "channel" is really the user id, and any `discord_oauth_identify`
 * binding — an `identify` grant conveys who somebody is and no channel at all, so a channel recorded
 * against one cannot have been verified.
 *
 * Exported because it is the whole safety property, and a property worth stating is worth testing
 * without a Discord token.
 */
export function discordDeliveryRoute(target: {
  readonly channelChatId: string | null;
  readonly channelUserId: string;
  readonly verificationMethod?: string | null;
}): DiscordDeliveryRoute {
  const chat = target.channelChatId?.trim() ?? "";
  if (chat === "") return { mode: "dm", reason: "no channel recorded" };
  if (chat === target.channelUserId.trim()) {
    return { mode: "dm", reason: "the recorded channel is the user id, which is not a channel" };
  }
  if (target.verificationMethod === "discord_oauth_identify") {
    return { mode: "dm", reason: "an identify grant verifies a user, never a channel" };
  }
  return { mode: "channel", channelId: chat };
}

/**
 * Make sure the account has a web surface to answer from, and references for it.
 *
 * Called by the delivery projection so the dashboard is never the channel that quietly has no way to
 * act. It refuses for an identity-only wallet, exactly as the paid decision route does, because a
 * browser is not a way around the rule that proving who you are is not permission to spend.
 */
export async function ensureWebApprovalSurface(
  pool: Pool,
  approvalRequestId: string,
): Promise<{ bindingId: string; refs: { APPROVE: string; DENY: string } } | null> {
  const facts = await factsFor(pool, approvalRequestId);
  if (!facts) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: wallets } = await client.query<{ scopes: string[] | null }>(
      `SELECT scopes FROM untch_wallet_bindings WHERE account_id = $1 AND status = 'ACTIVE'`,
      [facts.accountId],
    );
    const scopes = wallets.flatMap((w) => w.scopes ?? []);
    const web = await ensureWebApprovalBinding(client as never, {
      accountId: facts.accountId,
      accountRefHash: facts.accountRefHash,
      walletScopes: scopes,
    });
    if (!web.ok) {
      await client.query("ROLLBACK");
      return null;
    }
    const refs = await ensureActionReferences(client as never, {
      approvalRequestId,
      accountId: facts.accountId,
      accountRefHash: facts.accountRefHash,
      channelBindingId: web.bindingId,
      approvalDigest: facts.approvalDigest,
      expiresAt: facts.expiresAt,
    });
    await client.query("COMMIT");
    return { bindingId: web.bindingId, refs };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
