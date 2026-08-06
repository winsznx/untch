import { createHmac, timingSafeEqual, verify as ed25519Verify } from "node:crypto";
import type { Express, Request, Response } from "express";
import express from "express";
import {
  actOnApproval,
  consumeActionRef,
  mintTokenForRef,
  resolveActionRef,
  type Pool,
} from "@untch/consumer-core";
import { ledgerPartitionKey } from "@untch/policy-engine";

/**
 * Native Discord approvals: one tap, inside Discord, no browser.
 *
 * WHY THIS REPLACES THE LINK BUTTONS
 *
 * The proven flow works and is secure, and it asks a person who is already in Discord to open a
 * browser, sign in to Discord again, read a page and press a second button. Four steps to answer a
 * question they were already looking at. That was a consequence of having no Interactions Endpoint,
 * not a design anybody chose.
 *
 * WHAT MAKES THIS SAFE WITHOUT OAUTH
 *
 * Discord signs every interaction with Ed25519 over `timestamp + rawBody`, against the application's
 * public key. A valid signature is Discord asserting "this user, in this message, pressed this
 * button". So the identity does not come from the request body — it comes from a signature we verify
 * before parsing anything, which is a stronger statement than an OAuth round trip because it cannot be
 * replayed onto a different message.
 *
 * THE RAW BODY IS THE WHOLE SECURITY PROPERTY
 *
 * The signature covers the exact bytes Discord sent. Parsing to JSON and re-serialising changes those
 * bytes — key order, whitespace, unicode escapes — so this route takes `express.raw` and verifies
 * BEFORE `JSON.parse`. A JSON body parser mounted above it would silently destroy the evidence.
 */

export const DISCORD_INTERACTIONS_ROUTE = "/consumer/approvals/action/discord/interactions" as const;

/** Discord rejects a signature older than this; so do we, so a captured request cannot be held. */
const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

const TOKEN_TTL_MS = 10 * 60_000;
const DECIDE_SCOPE = "policy-approval" as const;

/** Discord interaction types. Only PING and MESSAGE_COMPONENT are accepted. */
const PING = 1;
const MESSAGE_COMPONENT = 3;

/**
 * Discord response types, from the official interactions documentation.
 *
 * `DEFERRED_UPDATE_MESSAGE` (6) is the one that matters here: it ACKs a COMPONENT interaction and
 * lets the original message be edited later, WITHOUT showing the person a loading state. Discord gives
 * three seconds for that first response and invalidates the token if it is missed; the token then
 * stays usable for fifteen minutes, which is the window the edit has to land in.
 */
const PONG = 1;
const DEFERRED_UPDATE_MESSAGE = 6;
const UPDATE_MESSAGE = 7;

/** Discord's hard deadline for the FIRST response. Everything slow must happen after it. */
export const DISCORD_ACK_DEADLINE_MS = 3_000;

export interface DiscordInteractionDeps {
  readonly pool: Pool;
  /** The action-token secret, the same one the OAuth path uses. */
  readonly secret: string;
  /** The Discord application PUBLIC key, hex. Absent means this deployment cannot verify. */
  readonly publicKey: string | null;
  /** Whether native buttons are advertised as working. False keeps the endpoint honest while it beds in. */
  readonly nativeReady: boolean;
  /** Needed to edit the original message after deferring: PATCH /webhooks/{applicationId}/{token}/messages/@original */
  readonly applicationId: string | null;
  /** Injected so a test can drive the edit without a network, and so retries are observable. */
  readonly editOriginal?: (applicationId: string, interactionToken: string, body: unknown) => Promise<{ ok: boolean; status: number }>;
  /** Awaited by tests so the post-ACK work can be observed; production leaves it unset. */
  readonly onSettled?: (outcome: { verdict: string; edited: boolean }) => void;
  /** A deliberate delay on the NON-FINANCIAL probe only, so the early ACK can be proven live. */
  readonly smokeDelayMs?: number;
  /**
   * A deliberate delay INSIDE the decision, for tests only.
   *
   * The property under test is that the acknowledgement is already sent while the transaction is still
   * running, and the only way to observe that is to make the transaction slow on purpose.
   */
  readonly resolveDecisionDelayMs?: () => number;
  readonly resolvePolicy: (policyId: string) => Promise<{ status: string; expiresAtMs: number | null; dailyLimit: string | null } | null>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/**
 * The custom id a button carries.
 *
 * `v1:APPROVE:<opaque action reference>` and nothing else. The reference is already a 32-byte
 * unguessable value, and everything a decision binds — account, request, digest, amount, recipient,
 * policy, the Discord subject — is looked up from it server-side.
 *
 * Discord caps custom ids at 100 characters, which is another reason nothing descriptive belongs here.
 */
export function buildCustomId(action: "APPROVE" | "DENY", actionReferenceId: string): string {
  return `v1:${action}:${actionReferenceId}`;
}

/**
 * The non-financial probe button.
 *
 * A native button that carries NO action reference — so the branch that redeems it has no approval to
 * resolve, no token to mint and no decision to reach. It exists because the only way to prove Discord
 * accepts this endpoint, delivers a real interaction and lets the message be edited is to have a
 * person press one, and doing that with a live approval would mean putting a payment in front of
 * somebody to test a button.
 *
 * Sealed rather than plain, so a stranger cannot mint one for a binding they do not hold.
 */
export function sealSmokeCustomId(secret: string, channelBindingId: string): string {
  const mac = createHmac("sha256", secret).update(`untch.discord.smoke.v1.${channelBindingId}`).digest("base64url").slice(0, 24);
  return `v1:SMOKE:${Buffer.from(channelBindingId, "utf8").toString("base64url")}.${mac}`;
}

export function openSmokeCustomId(secret: string, raw: string): string | null {
  const body = raw.slice("v1:SMOKE:".length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  let bindingId: string;
  try {
    bindingId = Buffer.from(body.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`untch.discord.smoke.v1.${bindingId}`).digest("base64url").slice(0, 24),
    "utf8",
  );
  const got = Buffer.from(body.slice(dot + 1), "utf8");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return bindingId;
}

export type ParsedCustomId =
  | { readonly ok: true; readonly action: "APPROVE" | "DENY"; readonly actionReferenceId: string }
  | { readonly ok: false; readonly refusal: string };

export function parseCustomId(raw: unknown): ParsedCustomId {
  if (typeof raw !== "string") return { ok: false, refusal: "CUSTOM_ID_MISSING" };
  const parts = raw.split(":");
  if (parts.length !== 3) return { ok: false, refusal: "CUSTOM_ID_MALFORMED" };
  const [version, action, ref] = parts as [string, string, string];
  if (version !== "v1") return { ok: false, refusal: "CUSTOM_ID_VERSION" };
  if (action !== "APPROVE" && action !== "DENY") return { ok: false, refusal: "CUSTOM_ID_ACTION" };
  if (!/^aref_[A-Za-z0-9_-]{20,}$/.test(ref)) return { ok: false, refusal: "CUSTOM_ID_REFERENCE" };
  return { ok: true, action, actionReferenceId: ref };
}

/**
 * Verify Discord's Ed25519 signature over `timestamp + rawBody`.
 *
 * Exported so the property is testable without a network, and written to fail closed on every
 * malformed input rather than throwing — a thrown error in a signature check is a 500 where a refusal
 * belongs.
 */
export function verifyDiscordSignature(args: {
  readonly publicKeyHex: string;
  readonly signatureHex: string | undefined;
  readonly timestamp: string | undefined;
  readonly rawBody: Buffer;
  readonly nowMs: number;
}): { ok: true } | { ok: false; refusal: string } {
  if (!args.signatureHex || !args.timestamp) return { ok: false, refusal: "SIGNATURE_MISSING" };
  if (!/^[0-9a-fA-F]{128}$/.test(args.signatureHex)) return { ok: false, refusal: "SIGNATURE_MALFORMED" };
  if (!/^[0-9a-fA-F]{64}$/.test(args.publicKeyHex)) return { ok: false, refusal: "PUBLIC_KEY_MALFORMED" };

  /**
   * The timestamp is covered by the signature, so it cannot be edited — but a VALID captured request
   * could otherwise be replayed indefinitely. Discord's own window is five minutes.
   */
  const tsSec = Number(args.timestamp);
  if (!Number.isFinite(tsSec)) return { ok: false, refusal: "TIMESTAMP_MALFORMED" };
  if (Math.abs(args.nowMs - tsSec * 1000) > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, refusal: "TIMESTAMP_STALE" };
  }

  try {
    /** Ed25519 SPKI prefix, so a raw 32-byte key can be handed to `crypto.verify`. */
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(args.publicKeyHex, "hex"),
    ]);
    const key = { key: spki, format: "der" as const, type: "spki" as const };
    const signed = Buffer.concat([Buffer.from(args.timestamp, "utf8"), args.rawBody]);
    const ok = ed25519Verify(null, signed, key, Buffer.from(args.signatureHex, "hex"));
    return ok ? { ok: true } : { ok: false, refusal: "SIGNATURE_INVALID" };
  } catch {
    return { ok: false, refusal: "SIGNATURE_INVALID" };
  }
}

/** What the message becomes once it has been answered. Buttons are removed, so nothing stays pressable. */
export function resolvedMessage(args: {
  readonly verdict: string;
  readonly detail: string;
  readonly amount?: string | null | undefined;
  readonly asset?: string | null | undefined;
}): Record<string, unknown> {
  const headline =
    args.amount && args.asset ? `${args.verdict} — ${args.amount} ${args.asset}` : args.verdict;
  return {
    content: headline,
    embeds: [{ title: headline, description: args.detail }],
    /** Empty, so a resolved approval has no button left to press. */
    components: [],
  };
}

/**
 * Deps may be a value or a THUNK, and the thunk is the one production uses.
 *
 * This route has to be mounted above every body parser, and the wiring it needs — the pool, the
 * session secret, the policy reader — is resolved further down the same function. A value would
 * therefore be null at registration time and stay null forever. A thunk is read per request, so the
 * route can sit where the raw bytes are still intact and still see the configuration that arrives
 * later.
 */
/**
 * Edit the original message after deferring.
 *
 * PATCH /webhooks/{applicationId}/{interactionToken}/messages/@original, which is the documented way
 * to replace a deferred component response. The interaction token is good for fifteen minutes.
 *
 * RETRIED, AND NEVER ROLLED BACK.
 *
 * By the time this runs the decision is committed. A failed edit is a display problem and a committed
 * decision is a financial fact, so the two must not be able to argue: this retries a few times and
 * then gives up, and the caller treats "not edited" as a message that stayed as it was — never as a
 * reason to undo anything.
 *
 * A 404 or 401 means the token is stale or already consumed; those are not retried, because repeating
 * them cannot succeed and the decision stands regardless.
 */
async function editOriginalMessage(
  d: DiscordInteractionDeps,
  interactionToken: string | null,
  body: unknown,
): Promise<boolean> {
  if (!interactionToken || !d.applicationId) return false;
  const send =
    d.editOriginal ??
    (async (appId: string, token: string, payload: unknown) => {
      const res = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { ok: res.ok, status: res.status };
    });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out = await send(d.applicationId, interactionToken, body).catch(() => ({ ok: false, status: 0 }));
    if (out.ok) return true;
    /** A stale or unknown token cannot be fixed by trying again. */
    if (out.status === 404 || out.status === 401) return false;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  return false;
}

export function registerDiscordInteractionRoutes(
  app: Express,
  deps: DiscordInteractionDeps | null | (() => DiscordInteractionDeps | null),
): void {
  const resolve = (): DiscordInteractionDeps | null => (typeof deps === "function" ? deps() : deps);
  if (deps === null) {
    app.post(DISCORD_INTERACTIONS_ROUTE, (_req, res) => {
      res.status(503).json({ code: "DISCORD_INTERACTIONS_UNAVAILABLE", message: "not wired on this instance", retryable: false, docsUrl: null });
    });
    return;
  }

  /**
   * `express.raw` and NOT `express.json`.
   *
   * The signature covers the exact bytes Discord sent, so this route must see them. Mounted per-route
   * rather than globally, because every other surface here wants parsed JSON.
   */
  app.post(DISCORD_INTERACTIONS_ROUTE, express.raw({ type: "*/*", limit: "1mb" }), (req: Request, res: Response) => {
    void (async () => {
      const d = resolve();
      if (!d) {
        res.status(503).json({ code: "DISCORD_INTERACTIONS_UNAVAILABLE", message: "not wired on this instance", retryable: false, docsUrl: null });
        return;
      }
      const now = (): number => d.now?.() ?? Date.now();
      const log = (line: string): void => d.log?.(`[discord-interactions] ${line}`);

      /**
       * If this is not a Buffer, a body parser ran BEFORE this route and the exact bytes Discord
       * signed are gone. The signature could never verify, so refusing quietly would look like Discord
       * sending bad signatures forever. It is named instead, because the cause is wiring order and the
       * fix is to register this route above `express.json`.
       */
      if (!Buffer.isBuffer(req.body)) {
        log(JSON.stringify({ stage: "verify", refusal: "RAW_BODY_CONSUMED" }));
        res.status(500).json({
          code: "DISCORD_RAW_BODY_CONSUMED",
          message: "a body parser ran before the interactions route, so Discord's signature cannot be verified",
          retryable: false,
          docsUrl: null,
        });
        return;
      }
      const raw = req.body;
      if (!d.publicKey) {
        res.status(503).json({ code: "DISCORD_PUBLIC_KEY_ABSENT", message: "this deployment cannot verify a Discord interaction", retryable: false, docsUrl: null });
        return;
      }

      const verified = verifyDiscordSignature({
        publicKeyHex: d.publicKey,
        signatureHex: req.header("X-Signature-Ed25519") ?? undefined,
        timestamp: req.header("X-Signature-Timestamp") ?? undefined,
        rawBody: raw,
        nowMs: now(),
      });
      if (!verified.ok) {
        /**
         * 401 with no body detail. Discord requires a non-2xx for a bad signature during endpoint
         * validation, and a caller probing this endpoint learns nothing from the refusal.
         */
        log(JSON.stringify({ stage: "verify", refusal: verified.refusal }));
        res.status(401).send("invalid request signature");
        return;
      }

      let interaction: Record<string, unknown>;
      try {
        interaction = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        res.status(400).send("malformed interaction");
        return;
      }

      /** Discord validates the endpoint by sending a signed PING and requiring exactly this. */
      if (interaction.type === PING) {
        log(JSON.stringify({ stage: "ping" }));
        res.status(200).json({ type: PONG });
        return;
      }

      if (interaction.type !== MESSAGE_COMPONENT) {
        res.status(400).send("unsupported interaction type");
        return;
      }

      const data = (interaction.data ?? {}) as Record<string, unknown>;
      /**
       * The probe branch, taken BEFORE the action path and returning from inside it. It reads a
       * binding and a signed subject and touches nothing else — there is no approval reference in the
       * custom id, so there is nothing here that could reach a decision.
       */
      if (typeof data.custom_id === "string" && data.custom_id.startsWith("v1:SMOKE:")) {
        const bindingId = openSmokeCustomId(d.secret, data.custom_id);
        const subjectForSmoke = typeof ((interaction.member as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined)?.id === "string"
          ? String((((interaction.member as Record<string, unknown>).user) as Record<string, unknown>).id)
          : typeof (interaction.user as Record<string, unknown> | undefined)?.id === "string"
            ? String((interaction.user as Record<string, unknown>).id)
            : null;
        if (!bindingId || !subjectForSmoke) {
          res.status(200).json({ type: UPDATE_MESSAGE, data: resolvedMessage({ verdict: "Refused", detail: "This test button was not issued by this server." }) });
          return;
        }
        const { rows } = await d.pool.query<{ channel_user_id: string; status: string }>(
          `SELECT channel_user_id, status FROM untch_channel_bindings WHERE binding_id = $1`,
          [bindingId],
        );
        const b = rows[0];
        const ok = Boolean(b) && b!.status === "ACTIVE" && b!.channel_user_id === subjectForSmoke;
        log(JSON.stringify({ stage: "smoke", matched: ok }));

        /**
         * The probe defers exactly as the real path does, then waits, then edits. The wait is the
         * whole point: if the ACK were not early, a delay past three seconds would show "This
         * interaction failed" — so a probe that edits successfully AFTER a deliberate delay is proof
         * the acknowledgement really is separate from the work.
         */
        const smokeToken = typeof interaction.token === "string" ? interaction.token : null;
        res.status(200).json({ type: DEFERRED_UPDATE_MESSAGE });
        const delayMs = d.smokeDelayMs ?? 0;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const smokeEdited = await editOriginalMessage(d, smokeToken, ok
            ? {
                content: "**Native Discord approval path verified.**",
                embeds: [{
                  title: "Native Discord approval path verified",
                  description:
                    "Discord signed this button press, the server verified the signature, matched your " +
                    "Discord identity to the approval channel on this account, and edited this message " +
                    "in place — without opening a browser.\n\n" +
                    "Nothing was approved, denied or paid. This test carried no approval request, no " +
                    "payment, no action token and no authority.",
                }],
                components: [],
              }
            : resolvedMessage({ verdict: "Refused", detail: "This identity does not hold the named approval channel." }));
        log(JSON.stringify({ stage: "smoke-edit", matched: ok, delayedMs: delayMs, edited: smokeEdited }));
        d.onSettled?.({ verdict: ok ? "Verified" : "Refused", edited: smokeEdited });
        return;
      }

      const parsed = parseCustomId(data.custom_id);
      if (!parsed.ok) {
        res.status(200).json({ type: UPDATE_MESSAGE, data: resolvedMessage({ verdict: "Refused", detail: "This button is not one this server issued." }) });
        return;
      }

      /**
       * THE IDENTITY, TAKEN FROM THE SIGNED ENVELOPE AND NOWHERE ELSE.
       *
       * `member.user.id` in a guild, `user.id` in a DM. Both are inside the body Discord signed. A user
       * id appearing in `custom_id` or anywhere else the client controls is ignored — this is the one
       * field an attacker would want to choose, so it is read only from what the signature covers.
       */
      const member = (interaction.member ?? {}) as Record<string, unknown>;
      const memberUser = (member.user ?? {}) as Record<string, unknown>;
      const directUser = (interaction.user ?? {}) as Record<string, unknown>;
      const subject = typeof memberUser.id === "string" ? memberUser.id : typeof directUser.id === "string" ? directUser.id : null;
      if (!subject) {
        res.status(200).json({ type: UPDATE_MESSAGE, data: resolvedMessage({ verdict: "Refused", detail: "Discord did not identify who pressed this." }) });
        return;
      }

      const messageId = typeof (interaction.message as Record<string, unknown> | undefined)?.id === "string"
        ? String((interaction.message as Record<string, unknown>).id)
        : null;

      /**
       * ── ACKNOWLEDGE FIRST, DECIDE AFTER ────────────────────────────────────
       *
       * Discord allows THREE SECONDS for the first response and invalidates the token if it is missed.
       * The decision below takes a transaction that locks the approval request — and another web or
       * OAuth action holding that row is exactly the case where the wait can outlast the deadline.
       * Answering afterwards would show the person "This interaction failed" over a decision that
       * committed perfectly.
       *
       * So the ACK is sent here, before any database work, as `DEFERRED_UPDATE_MESSAGE` — which ACKs a
       * component press without showing a loading state, leaving the original message exactly as it
       * was until there is a true terminal state to replace it with.
       */
      const interactionToken = typeof interaction.token === "string" ? interaction.token : null;
      res.status(200).json({ type: DEFERRED_UPDATE_MESSAGE });
      log(JSON.stringify({ stage: "ack", deferred: true }));

      /**
       * Everything past the ACK is a separate lifetime. It cannot reach `res`, so a slow transaction,
       * a failed edit or an unexpected throw changes what the person SEES and never what the database
       * decided.
       */
      const decisionDelay = d.resolveDecisionDelayMs?.() ?? 0;
      if (decisionDelay > 0) await new Promise((r) => setTimeout(r, decisionDelay));
      const outcome = await decideFromInteraction(d, {
        actionReferenceId: parsed.actionReferenceId,
        action: parsed.action,
        subject,
        messageId,
        nowMs: now(),
      });
      log(JSON.stringify({ stage: "decide", verdict: outcome.verdict, refusal: outcome.refusal ?? null }));

      const edited = await editOriginalMessage(d, interactionToken, {
        ...resolvedMessage({ verdict: outcome.verdict, detail: outcome.detail, amount: outcome.amount, asset: outcome.asset }),
      });
      log(JSON.stringify({ stage: "edit", verdict: outcome.verdict, edited }));
      d.onSettled?.({ verdict: outcome.verdict, edited });
    })().catch((err: unknown) => {
      /**
       * The ACK has already gone, so there is no response left to change. A throw here means the
       * decision could not be reached — never that it succeeded — and the message keeps its buttons
       * rather than being edited into a claim nothing supports.
       */
      resolve()?.log?.(`[discord-interactions] ${JSON.stringify({ stage: "failed", error: (err as Error).message.slice(0, 80) })}`);
    });
  });
}

interface InteractionOutcome {
  readonly verdict: "Approved" | "Denied" | "Superseded" | "Expired" | "Already resolved" | "Refused";
  readonly detail: string;
  readonly refusal?: string;
  readonly amount?: string | null;
  readonly asset?: string | null;
}

/**
 * Everything between a verified button press and a terminal decision.
 *
 * It calls the SAME `actOnApproval` the OAuth and web paths call. There is deliberately no second
 * decision implementation: native Discord differs from the browser in how it proves who is asking and
 * in nothing after that, which is what keeps "one terminal decision" a property of the code.
 */
async function decideFromInteraction(
  d: DiscordInteractionDeps,
  args: {
    readonly actionReferenceId: string;
    readonly action: "APPROVE" | "DENY";
    readonly subject: string;
    readonly messageId: string | null;
    readonly nowMs: number;
  },
): Promise<InteractionOutcome> {
  const client = await d.pool.connect();
  try {
    await client.query("BEGIN");

    /**
     * The request row is locked FIRST, before any reference is burned — the same ordering the OAuth
     * path takes, and for the same reason: own-ref-then-request-then-sibling-refs is a cycle when two
     * channels answer at once, and it deadlocked in production before the order was fixed.
     */
    const { rows: reqRows } = await client.query<{ approval_request_id: string; policy_id: string; state: string; amount: string; asset: string }>(
      `SELECT q.approval_request_id, q.policy_id, q.state, q.amount, q.asset
         FROM untch_approval_requests q
         JOIN untch_approval_action_refs r ON r.approval_request_id = q.approval_request_id
        WHERE r.action_reference_id = $1
          FOR UPDATE OF q`,
      [args.actionReferenceId],
    );
    const request = reqRows[0];
    if (!request) {
      await client.query("ROLLBACK");
      return { verdict: "Refused", detail: "This approval no longer exists.", refusal: "NOT_FOUND" };
    }

    /**
     * The interaction must have come from the message this delivery recorded. Without it, a button
     * copied out of one message could be pressed against another — the reference would still resolve,
     * and the person would be answering a question they were not shown.
     */
    if (args.messageId) {
      const { rows: deliveries } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM untch_approval_deliveries
          WHERE approval_request_id = $1 AND external_delivery_id = $2 AND channel = 'discord'`,
        [request.approval_request_id, args.messageId],
      );
      if (Number(deliveries[0]!.n) === 0) {
        await client.query("ROLLBACK");
        return { verdict: "Refused", detail: "This button did not come from the message it was issued in.", refusal: "MESSAGE_MISMATCH" };
      }
    }

    const verdict = await resolveActionRef(client as never, args.actionReferenceId, args.subject, args.nowMs);
    if (!verdict.ok) {
      await client.query("ROLLBACK");
      const map: Record<string, InteractionOutcome> = {
        EXPIRED: { verdict: "Expired", detail: "This approval window has closed." },
        ALREADY_CONSUMED: { verdict: "Already resolved", detail: "This approval has already been answered." },
        INVALIDATED: { verdict: "Superseded", detail: "A newer quote replaced this request." },
        DIGEST_MOVED: { verdict: "Superseded", detail: "The payment this described has changed." },
        REQUEST_NOT_PENDING: { verdict: "Already resolved", detail: "This request is no longer open." },
        SUBJECT_MISMATCH: { verdict: "Refused", detail: "This approval belongs to a different account holder." },
        BINDING_NOT_ACTIVE: { verdict: "Refused", detail: "This channel is no longer active." },
        BINDING_CANNOT_DECIDE: { verdict: "Refused", detail: "This channel may receive approvals and not answer them." },
      };
      return { ...(map[verdict.refusal] ?? { verdict: "Refused", detail: "This action is no longer valid." }), refusal: verdict.refusal };
    }

    if (verdict.ref.action !== args.action) {
      await client.query("ROLLBACK");
      return { verdict: "Refused", detail: "This button does not match the action it names.", refusal: "ACTION_MISMATCH" };
    }
    /** The grant, checked separately from the column, exactly as the OAuth callback does. */
    if (!verdict.ref.scopes.includes(DECIDE_SCOPE)) {
      await client.query("ROLLBACK");
      return { verdict: "Refused", detail: "This channel may receive approvals and not answer them.", refusal: "SCOPE_MISSING" };
    }

    const token = await mintTokenForRef(client as never, d.secret, verdict.ref, args.nowMs, TOKEN_TTL_MS);
    if (!token) {
      await client.query("ROLLBACK");
      return { verdict: "Refused", detail: "The request behind this action is gone.", refusal: "TOKEN_UNMINTABLE" };
    }
    if (!(await consumeActionRef(client as never, verdict.ref.actionReferenceId, token))) {
      await client.query("ROLLBACK");
      return { verdict: "Already resolved", detail: "This approval has already been answered.", refusal: "ALREADY_CONSUMED" };
    }

    const result = await actOnApproval(client as never, {
      approvalRequestId: verdict.ref.approvalRequestId,
      action: verdict.ref.action,
      token,
      tokenSecret: d.secret,
      channelBindingId: verdict.ref.channelBindingId,
      nowMs: args.nowMs,
      partitionKey: ledgerPartitionKey(request.policy_id),
      resolvePolicy: d.resolvePolicy,
    });

    if (result.outcome !== "APPROVED" && result.outcome !== "DENIED") {
      await client.query("ROLLBACK");
      const terminal = result.outcome === "ALREADY_RESOLVED";
      return {
        verdict: terminal ? "Already resolved" : result.outcome === "APPROVAL_SUPERSEDED" ? "Superseded" : "Refused",
        detail: result.detail ?? "Nothing was decided.",
        refusal: result.outcome,
        amount: request.amount,
        asset: request.asset,
      };
    }

    await client.query("COMMIT");
    return {
      verdict: result.outcome === "APPROVED" ? "Approved" : "Denied",
      detail:
        result.outcome === "APPROVED"
          ? "Reserved as authority under your policy. No money moved and no provider ran."
          : "Recorded as a refusal. No authority was created.",
      amount: request.amount,
      asset: request.asset,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    return { verdict: "Refused", detail: "Something went wrong and nothing was decided.", refusal: (err as Error).message.slice(0, 60) };
  } finally {
    client.release();
  }
}
