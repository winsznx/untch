/**
 * The Discord interaction endpoint on Workers.
 *
 * WHAT IS HERE AND WHAT IS NOT, STATED PLAINLY
 *
 * Discord validates a registered interactions URL by sending a SIGNED PING and requiring exactly
 * `{type: 1}` back. If that fails the endpoint is rejected outright and no button in any message will
 * ever reach this service again. That check, and the signature verification it depends on, are ported
 * here and are real.
 *
 * The MESSAGE_COMPONENT path — a human pressing Approve or Deny — is NOT ported. It defers within
 * three seconds, commits a decision, edits the original message through Discord's REST API, and has to
 * be replay-safe against a double press. That is the money path, and a partial version of it is worse
 * than an honest refusal: a button that acknowledges and then silently does nothing looks to an
 * operator exactly like a button that worked.
 *
 * So a component interaction gets a visible, named refusal in the Discord message itself rather than a
 * silent failure, and the operator is told to use the browser approval path.
 *
 * WHY THE RAW BYTES MATTER
 *
 * The signature covers `timestamp + rawBody` exactly as received. Anything that parses the body first
 * spends the stream and the signature can never verify again — which is why this route declares
 * `bodyMode: "raw"` and why `assertRawBodyRoutesFirst` refuses to deploy a table where a parsing route
 * could claim this path.
 */

import { DISCORD_INTERACTIONS_PATH as DISCORD_INTERACTIONS_ROUTE } from "../consumer/account-view";
import { verifyDiscordSignatureWorkers } from "./discord-signature";
import type { Route } from "./router";

/** Discord's own numbering. PING is validated on registration; PONG is the only accepted answer. */
const PING = 1;
const PONG = 1;
const MESSAGE_COMPONENT = 3;
/** Reply to the interaction with a message only the presser sees. */
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const EPHEMERAL = 64;

export interface DiscordRouteDeps {
  readonly publicKeyHex: string;
  readonly log?: (line: string) => void;
}

export function discordRoutes(deps: DiscordRouteDeps): readonly Route[] {
  const log = deps.log ?? (() => {});

  return [
    {
      method: "POST",
      pattern: DISCORD_INTERACTIONS_ROUTE,
      bodyMode: "raw",
      handler: async (req) => {
        const raw = req.rawBody ?? new Uint8Array();

        const verified = await verifyDiscordSignatureWorkers({
          publicKeyHex: deps.publicKeyHex,
          signatureHex: req.request.headers.get("x-signature-ed25519") ?? undefined,
          timestamp: req.request.headers.get("x-signature-timestamp") ?? undefined,
          rawBody: raw,
          nowMs: Date.now(),
        });

        if (!verified.ok) {
          /**
           * 401 with no detail. Discord REQUIRES a non-2xx for a bad signature during endpoint
           * validation, and a caller probing this endpoint learns nothing from the refusal.
           */
          log(`[discord] refused: ${verified.refusal}`);
          return new Response("invalid request signature", { status: 401 });
        }

        let interaction: Record<string, unknown>;
        try {
          interaction = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        } catch {
          return new Response("malformed interaction", { status: 400 });
        }

        if (interaction.type === PING) {
          log("[discord] ping");
          return new Response(JSON.stringify({ type: PONG }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (interaction.type !== MESSAGE_COMPONENT) {
          return new Response("unsupported interaction type", { status: 400 });
        }

        /**
         * Refused visibly rather than silently.
         *
         * The presser sees why, only they see it, and the original message is left untouched so the
         * approval is still there to act on through the browser path. Answering 200 with an ephemeral
         * message is the only way Discord will show text at all — a non-2xx here renders as "This
         * interaction failed", which says nothing about what to do instead.
         */
        log("[discord] component interaction refused: action path not ported");
        return new Response(
          JSON.stringify({
            type: CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: EPHEMERAL,
              content:
                "**Approvals have moved and this button is temporarily inactive.**\n\n" +
                "Nothing was approved, denied or paid by this press. The approval is unchanged — open " +
                "it from your Untch dashboard to act on it.",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  ];
}

/** The paths this module serves. Named once so the route classifier reads truth, not a guess. */
export const DISCORD_PATHS = [DISCORD_INTERACTIONS_ROUTE] as const;
