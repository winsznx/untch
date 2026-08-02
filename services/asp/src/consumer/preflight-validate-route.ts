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

      const result = await handlePublicPreflight(
        b.request ?? {},
        `Bearer ${token}`,
        { ...deps.publicDeps, evidenceTx: rollingBack },
        deps.engineDeps(),
      );

      res.status(result.status).json({
        ...result.body,
        validation: {
          billed: false,
          persisted: false,
          // True when the INSERTs ran against the real constraints before being discarded. False
          // means the decision never reached the write, which is a different kind of pass.
          writesExecutedThenRolledBack: wrote,
          note:
            "This ran handlePublicPreflight with the production deps and a transaction that always " +
            "rolls back. No x402 payment was taken and nothing was persisted.",
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
