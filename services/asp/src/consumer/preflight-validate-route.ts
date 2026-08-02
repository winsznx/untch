/**
 * The non-billable proof that the PAID path produces complete V2 evidence.
 *
 * WHY THIS IS NOT A SECOND IMPLEMENTATION
 *
 * It calls `handlePublicPreflight` — the exact function the priced route calls — with the exact deps
 * the priced route uses, differing in one thing: the `evidenceTx` it is handed ROLLS BACK instead of
 * committing. Same request mapper, same account resolver, same policy loader, same quote
 * canonicaliser, same evaluator, same assembler, same store SQL, same public projection.
 *
 * A validation route with its own cheaper path would validate that path. This one cannot, because
 * there is no code here that the paid route does not also run.
 *
 * WHAT WENT WRONG THE FIRST TIME, AND WHY THE FIX IS SHAPED THIS WAY
 *
 * The first version passed `preflightEngineDeps()` unchanged. Those deps carry the escalation gateway
 * and the receipt enqueuer, and BOTH act on the pool rather than on the caller's transaction. So a
 * validation call that rolled back its own writes perfectly still created a real escalation row,
 * wrote three real receipt rows, and sent real Telegram, Discord and Slack messages to a human.
 *
 * Rolling back a transaction cannot un-send a message. The only defence is not performing the effect,
 * so `suppressExternalEffects` REMOVES those dependencies rather than asking them to behave. A flag
 * they check would be a flag somebody forgets to check; an absent dependency cannot fire.
 *
 * WHY IT IS NOT AN x402 BYPASS
 *
 * It sits behind the operator token, on `/internal`, and it rolls back. It returns a decision that is
 * not persisted, against a request that is not billed, and there is no way to make it persist one:
 * the transaction wrapper is constructed here and always ends in ROLLBACK. A caller who wanted a real
 * decision would get nothing durable from it.
 */

import type { Express, Request, Response } from "express";
import { authenticateOperator } from "../internal-auth";
import { handlePublicPreflight, type PublicPreflightDeps } from "../public-dto/preflight";
import type { PreflightDeps } from "../handlers";
import { mintAccountSession } from "./account-auth";
import type { AccountStore, BindingScope, Pool } from "@untch/consumer-core";

/**
 * The dependencies that reach outside this process, removed.
 *
 * Every one of these performs an effect a rollback cannot undo:
 *
 *   escalationGateway — creates an escalation row on the POOL and fans out to Telegram, Discord,
 *                       Slack and iMessage. This is the one that messaged a human during a run that
 *                       claimed to be non-billable and non-persistent.
 *   receiptEnqueuer   — writes a receipt row on the POOL and queues it for on-chain anchoring.
 *   intentRegistry    — broadcasts `setStatus` to SpendIntentRegistry on X Layer.
 *   oracleSigner      — signs a Mode C spend authorisation, which is a credential once it exists.
 *
 * Returned as a type that cannot carry them, so a future edit that adds one back fails to compile
 * rather than failing in somebody's notifications.
 */
export type SuppressedPreflightDeps = Omit<
  PreflightDeps,
  "escalationGateway" | "receiptEnqueuer" | "intentRegistry" | "oracleSigner"
>;

export function suppressExternalEffects(deps: PreflightDeps): SuppressedPreflightDeps {
  const {
    escalationGateway: _gateway,
    receiptEnqueuer: _receipts,
    intentRegistry: _registry,
    oracleSigner: _signer,
    ...rest
  } = deps;
  return rest;
}

export const OPERATOR_PREFLIGHT_VALIDATE_ROUTE = "/internal/consumer/preflight-validate" as const;

export interface PreflightValidateDeps {
  readonly pool: Pool;
  readonly accounts: AccountStore;
  readonly publicDeps: PublicPreflightDeps | null;
  readonly engineDeps: (() => PreflightDeps) | null;
  readonly secret: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function registerPreflightValidateRoute(app: Express, deps: PreflightValidateDeps): void {
  const env = deps.env ?? process.env;

  app.post(OPERATOR_PREFLIGHT_VALIDATE_ROUTE, (req: Request, res: Response) => {
    void (async () => {
      const auth = authenticateOperator(req, { route: OPERATOR_PREFLIGHT_VALIDATE_ROUTE, env });
      if (!auth.ok) {
        res.status(auth.status).json({ code: auth.code, message: auth.message, retryable: false, docsUrl: null });
        return;
      }
      if (!deps.publicDeps || !deps.engineDeps) {
        res.status(503).json({
          code: "PREFLIGHT_NOT_CONFIGURED",
          message: "the public preflight path is not wired on this instance",
          retryable: false,
          docsUrl: null,
        });
        return;
      }

      const b = (req.body ?? {}) as Record<string, unknown>;
      const accountId = typeof b.accountId === "string" ? b.accountId : null;
      if (!accountId) {
        res.status(400).json({ code: "ACCOUNT_ID_REQUIRED", message: "accountId is required", retryable: false, docsUrl: null });
        return;
      }

      /**
       * A session minted for the account being validated.
       *
       * The handler takes a bearer because that is how a real caller proves itself, and this route
       * must not weaken that. So it mints one from the account's OWN active primary binding — an
       * operator can validate an account's path, and cannot conjure authority for a wallet that is
       * not bound.
       */
      const account = await deps.accounts.getAccount(accountId);
      if (!account) {
        res.status(404).json({ code: "ACCOUNT_NOT_FOUND", message: `no account ${accountId}`, retryable: false, docsUrl: null });
        return;
      }
      const wallets = await deps.accounts.walletsFor(accountId);
      const primary = wallets.find((w) => w.bindingId === account.primaryWalletBindingId && w.status === "ACTIVE");
      if (!primary) {
        res.status(409).json({
          code: "NO_ACTIVE_PRIMARY_WALLET",
          message: `account ${accountId} has no active primary wallet binding to validate against`,
          retryable: false,
          docsUrl: null,
        });
        return;
      }
      const { token } = mintAccountSession({
        secret: deps.secret,
        accountId,
        address: primary.address as `0x${string}`,
        bindingId: primary.bindingId,
        scopes: primary.scopes as readonly BindingScope[],
        nowMs: Date.now(),
      });

      /**
       * The one difference from the paid route: this transaction always rolls back.
       *
       * Constructed here rather than taken from the request, so there is no input that makes it
       * commit. The writes execute — the same INSERTs, against the same constraints, so a CHECK
       * violation still surfaces — and then vanish.
       */
      let wrote = false;
      const rollingBack = async <T,>(fn: (tx: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> => {
        const client = await deps.pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn(client as unknown as { query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> });
          wrote = true;
          return out;
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      };

      /**
       * Every outbound effect removed BEFORE the handler runs.
       *
       * Not disabled by a flag the gateway checks — removed, so there is nothing present to fire.
       */
      const suppressed = suppressExternalEffects(deps.engineDeps());

      const result = await handlePublicPreflight(
        b.request ?? {},
        `Bearer ${token}`,
        { ...deps.publicDeps, evidenceTx: rollingBack },
        suppressed as PreflightDeps,
      );

      res.status(result.status).json({
        ...result.body,
        validation: {
          billed: false,
          persisted: false,
          // True when the INSERTs ran against the real constraints before being discarded. False
          // means the decision never reached the write, which is a different kind of pass.
          writesExecutedThenRolledBack: wrote,
          // Stated per effect rather than as one reassuring sentence, because the first version of
          // this route said "nothing was persisted" while sending three channel messages.
          suppressed: {
            channelDelivery: true,
            escalationCreation: true,
            receiptWrite: true,
            receiptAnchoring: true,
            intentRegistryBroadcast: true,
            oracleSignature: true,
            payment: true,
          },
          note:
            "handlePublicPreflight ran with the production request path and a transaction that always " +
            "rolls back. Every dependency that acts outside this process was REMOVED before the call, " +
            "so no message, receipt, anchor or signature could be produced.",
        },
      });
    })().catch((err: unknown) => {
      res.status(500).json({
        code: "VALIDATION_FAILED",
        message: (err as Error).message,
        retryable: false,
        docsUrl: null,
      });
    });
  });
}
