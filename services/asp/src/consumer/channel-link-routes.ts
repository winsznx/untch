import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  consumeChannelLink,
  linkTokenFingerprint,
  mintChannelLinkToken,
  newLinkCodeId,
  newLinkNonce,
  readChannelLinkToken,
  type LinkChannel,
  type LinkScope,
  type PlatformSubject,
  type Pool,
} from "@untch/consumer-core";

/**
 * The genuine channel-link flows.
 *
 * WHAT MAKES A BINDING REAL
 *
 * The platform says who the person is. Not an environment variable, not a chat id an operator happens
 * to hold, not a handle somebody typed. Telegram's `/start` callback carries an authenticated
 * `from.id`; Discord's interaction carries an authenticated `member.user.id`. Those are the only
 * things here that constitute proof, and everything else exists to make that proof attributable to one
 * account, one channel and one scope.
 *
 * WHAT A LINK REQUEST IS NOT
 *
 * Requesting a link creates nothing. No binding, no scope, no delivery target, no approval capability.
 * It creates a question with an expiry. If the human never opens it, the row ages out and the world is
 * exactly as it was.
 *
 * WHY THE INBOUND WEBHOOK IS AUTHENTICATED TWICE
 *
 * The platform proves the USER. It does not prove that the request reaching us came from the platform,
 * so a secret path token or signature check comes first. Without it anybody could POST a JSON body
 * claiming to be any Telegram user, and the link token alone would happily bind them.
 */

export interface ChannelLinkDeps {
  readonly pool: Pool;
  readonly linkSecret: string;
  readonly publicBaseUrl: string;
  /** Resolves a bearer to the account and the scopes its wallet holds. */
  readonly accountForSession: (
    authorization: string | undefined,
  ) => Promise<{ accountId: string; accountRefHash: string; walletScopes: readonly string[] } | null>;
  readonly telegram: {
    readonly botUsername: string | null;
    /** Shared secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. */
    readonly webhookSecret: string | null;
    /**
     * Production-disabled while the bot cannot authenticate.
     *
     * The implementation stays, its tests stay, and its security requirements are not weakened. What
     * is switched off is the ability to ISSUE a link, because a link that cannot be completed is a
     * dead end handed to a user. Recovering the bot flips this back without touching the protocol.
     */
    readonly enabled: boolean;
  };
  readonly discord: {
    readonly applicationId: string | null;
    readonly redirectUri: string | null;
  };
  /**
   * Exchange an OAuth code for the user's OWN identity.
   *
   * A seam rather than an inline fetch, so a test can drive the same consume path production uses
   * without standing up Discord. What it must never become is a function that trusts anything the
   * browser supplied: the subject has to come from Discord's answer to the code exchange.
   */
  readonly exchangeDiscordCode: (code: string) => Promise<PlatformSubject | null>;
  readonly now?: () => number;
}

/**
 * The real exchange.
 *
 * Two calls, both server-to-server: the code becomes an access token, and the access token reads
 * `/users/@me`. The client secret never leaves this process and the user id never comes from a
 * redirect parameter, which is the whole reason OAuth is being used rather than trusting a query
 * string.
 */
export function discordCodeExchanger(config: {
  readonly applicationId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}): (code: string) => Promise<PlatformSubject | null> {
  return async (code: string) => {
    const body = new URLSearchParams({
      client_id: config.applicationId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    });
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!tokenRes.ok) return null;
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) return null;

    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!meRes.ok) return null;
    const me = (await meRes.json()) as { id?: string; username?: string };
    if (!me.id) return null;

    return {
      externalSubjectId: String(me.id),
      /** A DM channel is opened at send time. The user id is what identifies them. */
      deliveryTargetId: String(me.id),
      workspaceRef: null,
      displayLabel: me.username ? `@${me.username}` : null,
      verificationMethod: "discord_oauth_identify",
    };
  };
}

export const CHANNEL_LINK_START_ROUTE = "/consumer/account/channel/link/start" as const;
export const CHANNEL_LINK_STATUS_ROUTE = "/consumer/account/channel/link/status" as const;
export const TELEGRAM_WEBHOOK_ROUTE = "/consumer/channel/telegram/webhook" as const;
export const DISCORD_CALLBACK_ROUTE = "/consumer/channel/discord/callback" as const;

/**
 * Sixty minutes.
 *
 * Long enough that a person can be interrupted between opening the link and finishing the platform
 * step without having to ask for a new one. Short enough that an unused link in a browser history is
 * not a standing invitation. It is single-use regardless, so the window bounds exposure rather than
 * being the only thing preventing reuse.
 */
const LINK_TTL_MS = 60 * 60_000;

const KNOWN_SCOPES: readonly LinkScope[] = ["notify", "policy-approval"];

function refuse(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ code, message, retryable: false, docsUrl: null, ...extra });
}

/**
 * A constant-time compare that does not leak length, matching `internal-auth`.
 *
 * Comparing digests rather than raw values removes the length difference that makes `timingSafeEqual`
 * throw, so the comparison is uniform for every input shape.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHmac("sha256", "untch.webhook").update(presented).digest();
  const b = createHmac("sha256", "untch.webhook").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerChannelLinkRoutes(app: Express, deps: ChannelLinkDeps): void {
  const now = deps.now ?? (() => Date.now());

  /**
   * Ask for a link.
   *
   * Requires a session AND, for an approval-scoped link, a wallet that holds `policy-authority`. A
   * person cannot grant a channel more authority than their own session carries, which is the property
   * that stops an identity-only session from bootstrapping an approval channel and using it to spend.
   */
  app.post(CHANNEL_LINK_START_ROUTE, (req: Request, res: Response) => {
    void (async () => {
      const account = await deps.accountForSession(req.header("authorization"));
      if (!account) {
        return refuse(res, 401, "ACCOUNT_LINK_REQUIRED", "prove an account session before linking a channel");
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const channel = body.channel;
      if (channel !== "telegram" && channel !== "discord") {
        return refuse(res, 400, "UNKNOWN_CHANNEL", "channel must be telegram or discord");
      }

      const requested = Array.isArray(body.requestedScopes) ? (body.requestedScopes as unknown[]) : ["policy-approval"];
      const scopes: LinkScope[] = [];
      for (const s of requested) {
        if (typeof s !== "string" || !KNOWN_SCOPES.includes(s as LinkScope)) {
          return refuse(res, 400, "UNKNOWN_SCOPE", `requestedScopes may contain only ${KNOWN_SCOPES.join(", ")}`);
        }
        if (!scopes.includes(s as LinkScope)) scopes.push(s as LinkScope);
      }
      if (!scopes.includes("notify")) scopes.push("notify");

      if (scopes.includes("policy-approval") && !account.walletScopes.includes("policy-authority")) {
        /**
         * The refusal that keeps channel authority from exceeding wallet authority. A channel that
         * could approve payments for an account whose own session cannot would be a way to launder a
         * weaker credential into a stronger one.
         */
        return refuse(
          res,
          409,
          "AUTHORITY_NOT_DERIVABLE",
          "this session proves identity and does not carry authority to grant a channel approval rights",
          {
            missing: [
              {
                field: "scopes",
                why: "the wallet behind this session does not hold policy-authority",
                resolvedFrom: "re-link this wallet requesting policy-authority at POST /consumer/account/link/start",
              },
            ],
            resolveBy: "/consumer/account/link/start",
          },
        );
      }

      const codeId = newLinkCodeId();
      const nonce = newLinkNonce();
      const issuedAt = now();
      const expiresAt = issuedAt + LINK_TTL_MS;
      const token = mintChannelLinkToken(deps.linkSecret, {
        v: 1,
        codeId,
        accountRefHash: account.accountRefHash,
        channel: channel as LinkChannel,
        scopes,
        nonce,
        issuedAt,
        expiresAt,
      });

      /** The fingerprint, never the token. A stored token is a redeemable credential. */
      await deps.pool.query(
        `INSERT INTO untch_channel_bind_codes
           (code_id, account_id, channel, code_hash, status, expires_at, created_at, created_by,
            requested_scopes, nonce, account_ref_hash, token_fingerprint)
         VALUES ($1,$2,$3,$4,'PENDING',$5::timestamptz, now(),'channel-link',$6,$7,$8,$9)`,
        [
          codeId,
          account.accountId,
          channel,
          linkTokenFingerprint(token),
          new Date(expiresAt).toISOString(),
          scopes,
          nonce,
          account.accountRefHash,
          linkTokenFingerprint(token).slice(0, 16),
        ],
      );

      /**
       * Telegram carries the token in the `start` deep-link payload, which the bot receives verbatim.
       * Discord carries it in OAuth `state`, which comes back on the callback.
       */
      if (channel === "telegram" && !deps.telegram.enabled) {
        return refuse(
          res,
          503,
          "CHANNEL_DISABLED",
          "telegram linking is implemented and disabled on this deployment: the bot cannot currently authenticate",
          {
            channelStatus: {
              implementation: "CODE_COMPLETE",
              callbackVerification: "AUTOMATED_TEST_PROVEN",
              productionBotAuthentication: "BLOCKED",
              accountBinding: "BLOCKED_BY_PLATFORM_ACCOUNT_ACCESS",
              policyApproval: "DISABLED",
            },
          },
        );
      }

      const url =
        channel === "telegram"
          ? deps.telegram.botUsername
            ? `https://t.me/${deps.telegram.botUsername}?start=${token}`
            : null
          : deps.discord.applicationId
            ? `https://discord.com/oauth2/authorize?client_id=${deps.discord.applicationId}` +
              `&response_type=code&scope=identify` +
              `&redirect_uri=${encodeURIComponent(`${deps.publicBaseUrl}${DISCORD_CALLBACK_ROUTE}`)}` +
              `&state=${encodeURIComponent(token)}`
            : null;

      if (!url) {
        return refuse(
          res,
          503,
          "CHANNEL_NOT_CONFIGURED",
          `this deployment has no ${channel} application configured, so no link can be issued`,
        );
      }

      res.status(200).json({
        channel,
        linkUrl: url,
        codeId,
        requestedScopes: scopes,
        expiresAt: new Date(expiresAt).toISOString(),
        creates: [
          "one account-scoped channel binding, after the platform proves who completed it",
          scopes.includes("policy-approval")
            ? "the policy-approval scope, which lets this channel answer approval requests"
            : "the notify scope only, which can receive and never answer",
        ],
        doesNotCreate: [
          "any payment, settlement or transaction",
          "any approval of an existing request",
          "any budget reservation",
          "any authority for a channel identity other than the one that completes it",
        ],
      });
    })().catch(() => refuse(res, 500, "CHANNEL_LINK_FAILED", "the link could not be created"));
  });

  /** Whether a link has been completed. Says nothing about who completed it. */
  app.get(CHANNEL_LINK_STATUS_ROUTE, (req: Request, res: Response) => {
    void (async () => {
      const account = await deps.accountForSession(req.header("authorization"));
      if (!account) return refuse(res, 401, "ACCOUNT_LINK_REQUIRED", "prove an account session");
      const { rows } = await deps.pool.query<Record<string, unknown>>(
        `SELECT channel, status, expires_at, consumed_at, requested_scopes
           FROM untch_channel_bind_codes WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [account.accountId],
      );
      const { rows: bindings } = await deps.pool.query<Record<string, unknown>>(
        `SELECT channel, status, scopes, verification_method, verified_at
           FROM untch_channel_bindings WHERE account_id = $1 AND status IN ('ACTIVE','ACTIVE_RECEIVE_ONLY')`,
        [account.accountId],
      );
      res.status(200).json({
        links: rows.map((r) => ({
          channel: r.channel,
          status: r.status,
          requestedScopes: r.requested_scopes,
          expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : null,
          consumedAt: r.consumed_at instanceof Date ? r.consumed_at.toISOString() : null,
        })),
        /** Channel and scope only. The platform identity behind a binding is never published. */
        bindings: bindings.map((b) => ({
          channel: b.channel,
          status: b.status,
          scopes: b.scopes,
          verificationMethod: b.verification_method,
          verifiedAt: b.verified_at instanceof Date ? b.verified_at.toISOString() : null,
        })),
      });
    })().catch(() => refuse(res, 500, "CHANNEL_LINK_STATUS_FAILED", "status could not be read"));
  });

  /**
   * Telegram's inbound webhook.
   *
   * The secret header is checked FIRST. Telegram echoes a value we chose when the webhook was
   * registered, and without it this endpoint would accept a hand-written body claiming to be any user.
   * The link token cannot substitute for it: the token proves which account asked, and this proves the
   * claim about WHO answered actually came from Telegram.
   */
  app.post(TELEGRAM_WEBHOOK_ROUTE, (req: Request, res: Response) => {
    void (async () => {
      const expected = deps.telegram.webhookSecret;
      /**
       * Disabled means the webhook answers 200 and does nothing. Not an error: Telegram retries a
       * non-2xx, and a disabled endpoint that generates retry storms is worse than one that quietly
       * accepts and discards.
       */
      if (!expected || !deps.telegram.enabled) {
        res.status(200).json({ ok: true, linked: false, reason: "CHANNEL_DISABLED" });
        return;
      }
      const presented = req.header("x-telegram-bot-api-secret-token") ?? "";
      if (!presented || !secretMatches(presented, expected)) {
        /** 200 on purpose: Telegram retries a non-2xx, and a forged call should not earn retries. */
        res.status(200).json({ ok: true });
        return;
      }

      const update = (req.body ?? {}) as Record<string, unknown>;
      const message = (update.message ?? {}) as Record<string, unknown>;
      const from = (message.from ?? {}) as Record<string, unknown>;
      const chat = (message.chat ?? {}) as Record<string, unknown>;
      const text = typeof message.text === "string" ? message.text : "";

      const started = /^\/start\s+(\S+)/.exec(text);
      if (!started) {
        res.status(200).json({ ok: true });
        return;
      }
      const token = started[1]!;

      const verdict = readChannelLinkToken(deps.linkSecret, token, { channel: "telegram", nowMs: now() });
      if (!verdict.ok) {
        res.status(200).json({ ok: true, linked: false, reason: verdict.refusal });
        return;
      }

      const subject: PlatformSubject = {
        externalSubjectId: from.id === undefined || from.id === null ? "" : String(from.id),
        deliveryTargetId: chat.id === undefined || chat.id === null ? null : String(chat.id),
        workspaceRef: null,
        displayLabel: typeof from.username === "string" ? `@${from.username}` : null,
        verificationMethod: "telegram_start_callback",
      };

      const outcome = await inTransaction(deps.pool, (tx) =>
        consumeChannelLink(tx, {
          claims: verdict.claims,
          tokenFingerprint: linkTokenFingerprint(token),
          subject,
          nowMs: now(),
        }),
      );

      res.status(200).json(
        outcome.ok
          ? { ok: true, linked: true, channel: "telegram", scopes: outcome.scopes }
          : { ok: true, linked: false, reason: outcome.refusal },
      );
    })().catch(() => {
      res.status(200).json({ ok: true, linked: false, reason: "INTERNAL" });
    });
  });

  /**
   * Discord's OAuth callback.
   *
   * The `state` parameter carries the link token, and Discord returns it unchanged. The authorization
   * code is exchanged for the user's own identity, so the subject comes from Discord rather than from
   * anything the browser could set.
   */
  app.get(DISCORD_CALLBACK_ROUTE, (req: Request, res: Response) => {
    void (async () => {
      const token = typeof req.query.state === "string" ? req.query.state : null;
      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!token || !code) return refuse(res, 400, "LINK_BAD_CALLBACK", "state and code are both required");

      const verdict = readChannelLinkToken(deps.linkSecret, token, { channel: "discord", nowMs: now() });
      if (!verdict.ok) return refuse(res, 400, verdict.refusal, verdict.detail);

      const subject = await deps.exchangeDiscordCode(code);
      if (!subject) {
        return refuse(res, 400, "NO_PLATFORM_SUBJECT", "discord did not confirm an authenticated identity");
      }

      const outcome = await inTransaction(deps.pool, (tx) =>
        consumeChannelLink(tx, {
          claims: verdict.claims,
          tokenFingerprint: linkTokenFingerprint(token),
          subject,
          nowMs: now(),
        }),
      );

      if (!outcome.ok) return refuse(res, 409, outcome.refusal, outcome.detail);
      res
        .status(200)
        .type("text/plain")
        .send(
          "Discord linked to your Untch account.\n\n" +
            `Scopes: ${outcome.scopes.join(", ")}\n` +
            "No payment was made and nothing was approved. You can close this window.\n",
        );
    })().catch(() => refuse(res, 500, "CHANNEL_LINK_FAILED", "the link could not be completed"));
  });
}

async function inTransaction<T>(pool: Pool, fn: (tx: never) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client as never);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
