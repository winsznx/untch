/**
 * The contract a marketplace buyer actually purchases, wired for Workers.
 *
 * THE DEFECT
 *
 * Express serves ONE route per tool and branches on the body shape:
 *
 *   POST /preflight_payment  ->  looksPublic(body)       ? handlePublicPreflight : handlePreflightPayment
 *   POST /verify_delivery    ->  looksPublicVerify(body) ? handlePublicVerify    : handleVerifyDelivery
 *
 * The Cloudflare port kept only the second arm of each. So a buyer sending the shape we PUBLISH —
 * `{policyId, provider, capability, task, maxSpend, currency, deadline}`, the one whose own description
 * promises "every protocol value is derived server-side from production state" — reached a handler
 * demanding `intentHash` or an inline §8.1 struct, and was answered INTENT_REQUIRED.
 *
 * Proven live against a real registered policy and a real payment before this was written. The buyer
 * was not charged, because a failing handler settles nothing, but the two headline services were
 * unusable exactly as advertised. Every audit that counted status codes passed straight over it: the
 * route existed, priced correctly, challenged correctly, and answered the wrong contract.
 *
 * WHY THE DEPENDENCIES ARE NOT OPTIONAL HERE
 *
 * `evidenceTx` and `serviceCalls` are typed nullable for an instance with no database, and a PAID
 * decision then refuses rather than returning a success nothing recorded. This deployment has
 * Postgres through Hyperdrive, so both are built: a decision a buyer paid for must leave evidence, and
 * "we could not write it down" is a refusal rather than a quiet success.
 *
 * The transaction is opened on the REQUEST's own pool. A Worker forbids reusing an I/O object across
 * request contexts, so these are constructed per request beside the routes that use them, never
 * memoised.
 */

import {
  PgAccountStore,
  PgConsumerStore,
  PgServiceCallStore,
  type Pool,
} from "@untch/consumer-core";
import { findOwnedService } from "@untch/owned-work";
import { PolicyProvider } from "@untch/policy-store";
import { CHAIN, SETTLEMENT_TOKEN } from "../config";
import { parseVerifiedPaymentAuthorization } from "../consumer/payment-authorization";
import { handlePublicPreflight, looksPublic, type PublicPreflightDeps } from "../public-dto/preflight";
import { handlePublicVerify, looksPublicVerify, type PublicVerifyDeps } from "../public-dto/verify";
import type { HandlerResult } from "../handlers";

export { looksPublic, looksPublicVerify };

/**
 * The header the x402 gate has ALREADY verified, read off a Worker request.
 *
 * `rawPaymentAuthorizationHeader` takes an Express `Request` and calls `req.header`. Same two names,
 * same precedence, read from a `Headers` instead — kept in step with that list deliberately rather
 * than inventing a third spelling.
 *
 * Anything reaching the handler has been verified: the payment middleware answers an invalid
 * authorization with a 402 and never calls on. This reads what was verified and passes the facts —
 * nonce, payer, token, amount, recipient, chain. The signature and the assembled authorization are
 * deliberately excluded: both are bearer instruments, and a value travelling into application code
 * must not be spendable.
 */
export function workerPaymentAuthorizationHeader(request: Request): string | null {
  for (const name of ["payment-signature", "x-payment"]) {
    const value = request.headers.get(name);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

const bearerOf = (request: Request): string | undefined =>
  request.headers.get("authorization") ?? undefined;

export interface PublicSurfaceArgs {
  readonly pool: Pool;
  readonly policies: PolicyProvider;
  readonly sessionSecret: string;
  readonly registry: string;
}

/**
 * One transaction per decision, on the request's own pool.
 *
 * A paid decision that cannot record its evidence must fail rather than return success, so this is
 * neither optional nor best-effort. The client is released in a `finally` — a Worker leaking pooled
 * connections exhausts Hyperdrive's origin budget and starts refusing unrelated requests.
 */
function evidenceTxFor(pool: Pool) {
  return async <T>(
    fn: (tx: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }> }) => Promise<T>,
  ): Promise<T> => {
    const client = await (pool as unknown as {
      connect(): Promise<{
        query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
        release(): void;
      }>;
    }).connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };
}

export function publicPreflightDeps(args: PublicSurfaceArgs): PublicPreflightDeps {
  return {
    accounts: new PgAccountStore(args.pool as never) as never,
    policies: args.policies as never,
    ownedService: (provider: string, capability: string) => findOwnedService(provider, capability),
    network: {
      token: SETTLEMENT_TOKEN.address as `0x${string}`,
      symbol: SETTLEMENT_TOKEN.symbol,
      decimals: SETTLEMENT_TOKEN.decimals,
    },
    sessionSecret: args.sessionSecret,
    /**
     * False, and it changes no decision.
     *
     * It changes what an APPROVED decision is CALLED. This deployment wires no provider executor, so
     * claiming execution were enabled would let an approval read as work performed.
     */
    executionEnabled: false,
    evidenceTx: evidenceTxFor(args.pool),
    chainId: CHAIN.id,
    registry: args.registry,
    serviceCalls: new PgServiceCallStore(args.pool as never) as never,
  };
}

export function publicVerifyDeps(args: PublicSurfaceArgs): PublicVerifyDeps {
  return {
    store: new PgConsumerStore(args.pool as never) as never,
    accounts: new PgAccountStore(args.pool as never) as never,
    sessionSecret: args.sessionSecret,
    executionEnabled: false,
  };
}

/** The published preflight, with the payment carried in as evidence rather than capability. */
export function runPublicPreflight(
  body: unknown,
  request: Request,
  args: PublicSurfaceArgs,
  decisionDeps: unknown,
): Promise<HandlerResult> {
  return handlePublicPreflight(
    body,
    bearerOf(request),
    publicPreflightDeps(args),
    decisionDeps as never,
    parseVerifiedPaymentAuthorization(workerPaymentAuthorizationHeader(request), { chainId: CHAIN.id }),
  );
}

/** The published verify: one identifier, and the account it belongs to. */
export function runPublicVerify(
  body: unknown,
  request: Request,
  args: PublicSurfaceArgs,
): Promise<HandlerResult> {
  return handlePublicVerify(body, bearerOf(request), publicVerifyDeps(args));
}
