/**
 * The keyless live quote probe.
 *
 *   POST /internal/consumer/quote-preview — price a real capability against the real provider. Writes
 *                                           nothing, pays nothing, and loads no signer.
 *
 * WHY IT EXISTS
 *
 * The only way to discover that `shop.search` could not be quoted was to create a production intent and
 * watch it die at the quote stage. That is an expensive way to learn a request shape: the intent id is
 * consumed, the intent needs terminalising, and the discovery happened inside an arming window with a
 * treasury signer already installed on the deployment.
 *
 * This route moves that discovery to before the arming sequence. It drives the REAL adapter quote against
 * the REAL provider using production's own registry and capability metadata, so passing here means the
 * same code will price the same request when an intent does exist — and it does so with the rail disarmed
 * and no key anywhere in the process.
 *
 * WHAT IT REFUSES TO ACCEPT
 *
 * A provider URL, a recipient, a mint, a chain, a payment destination. Every one of those is read from
 * production configuration, for exactly the reason the intent routes refuse them: a preview that could be
 * pointed at an arbitrary endpoint would be a way to make production fetch anything, using an operator
 * token as the only credential.
 */

import type { Express, Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import {
  formatMoney,
  isConsumerActionType,
  parseMoney,
  stableStringify,
  confirmedAssetsFor,
  gtMoney,
  type Money,
} from "@untch/consumer-core";
import { authenticateOperator } from "../internal-auth";
import type { ConsumerWiring } from "./wiring";
import { classifyFailure } from "./operator-error-classification";
import { operatorEnvironmentOf } from "./operator-routes";

export const OPERATOR_QUOTE_PREVIEW_ROUTE = "/internal/consumer/quote-preview" as const;

export interface QuotePreviewDeps {
  readonly wiring: ConsumerWiring | null;
  readonly env?: NodeJS.ProcessEnv;
}

/** Derived from production, never accepted. Supplying one is a refusal rather than a silent override. */
const DERIVED_FIELDS = [
  "providerUrl",
  "baseUrl",
  "recipient",
  "payTo",
  "settlementRecipient",
  "tokenMint",
  "mint",
  "assetAddress",
  "chain",
  "chainConfig",
  "rail",
  "paymentRail",
  "treasury",
  "treasuryRef",
] as const;

export function registerConsumerQuotePreviewRoute(app: Express, deps: QuotePreviewDeps): void {
  const env = deps.env ?? process.env;

  app.post(OPERATOR_QUOTE_PREVIEW_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    const auth = authenticateOperator(req, { route: OPERATOR_QUOTE_PREVIEW_ROUTE, env });
    if (!auth.ok) {
      res.status(auth.status).json({
        code: auth.code,
        message: auth.message,
        retryable: auth.code === "OPS_AUTH_THROTTLED",
        docsUrl: null,
      });
      return;
    }
    const wiring = deps.wiring;
    if (!wiring) {
      res.status(503).json({
        code: "CONSUMER_PACK_NOT_CONFIGURED",
        message: "the Consumer Pack is not wired on this instance, so there is no registry to quote from",
        retryable: false,
        docsUrl: null,
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const refusals: { code: string; message: string }[] = [];
    for (const field of DERIVED_FIELDS) {
      if (body[field] !== undefined) {
        refusals.push({
          code: "FIELD_NOT_ACCEPTED",
          message: `\`${field}\` is read from production configuration and may not be supplied`,
        });
      }
    }
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const capability = typeof body.capability === "string" ? body.capability.trim() : "";
    const request = body.request;
    const maxRaw = typeof body.maxProviderAmount === "string" ? body.maxProviderAmount.trim() : "";
    const providerRef = typeof body.providerRef === "string" ? body.providerRef.trim() : capability;

    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(provider)) {
      refusals.push({ code: "PROVIDER_MALFORMED", message: "`provider` must be a registry provider id" });
    }
    if (!isConsumerActionType(capability)) {
      refusals.push({ code: "CAPABILITY_UNKNOWN", message: `'${capability}' is not a Consumer Pack action type` });
    }
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      refusals.push({ code: "REQUEST_MALFORMED", message: "`request` must be a JSON object" });
    }
    if (maxRaw === "") {
      refusals.push({
        code: "MAX_AMOUNT_MISSING",
        message: "`maxProviderAmount` is required — a preview states the ceiling it is checking against",
      });
    }
    if (refusals.length > 0) {
      res.status(400).json({
        code: "QUOTE_PREVIEW_INVALID",
        message: "the request did not validate",
        refusals,
        retryable: false,
        docsUrl: null,
      });
      return;
    }

    (async (): Promise<void> => {
      const { isProduction, environment } = operatorEnvironmentOf(env);

      const preview = await wiring.orchestrator.previewQuote({
        providerId: provider,
        capability: capability as Parameters<typeof wiring.orchestrator.previewQuote>[0]["capability"],
        providerRef,
        params: request as Readonly<Record<string, unknown>>,
      });
      const quote = preview.quote;

      /**
       * The ceiling is checked against the SETTLEMENT asset the provider actually quoted in.
       *
       * Parsing the caller's figure in the quoted asset rather than assuming a denomination is what makes
       * "0.020000" mean the same thing in the answer as it did in the request.
       */
      let ceiling: Money | null = null;
      try {
        ceiling = parseMoney(maxRaw, quote.settlementAsset);
      } catch {
        ceiling = null;
      }
      const withinCeiling = ceiling !== null && !gtMoney(quote.cost, ceiling);

      // Is the quoted asset one the registry has CONFIRMED for that chain? A preview that accepted an
      // unconfirmed token would be previewing a settlement production would refuse.
      const confirmed = confirmedAssetsFor(quote.settlementChain).some(
        (a) => a.symbol.toUpperCase() === quote.settlementAsset.symbol.toUpperCase(),
      );

      const terms = (quote.terms ?? {}) as Record<string, unknown>;
      res.status(200).json({
        provider: preview.providerId,
        capability,
        executionShape: preview.executionShape,
        quote: {
          providerRef: quote.providerRef,
          amount: formatMoney(quote.cost),
          atomicAmount: quote.cost.amount.toString(),
          asset: quote.settlementAsset.symbol,
          chain: quote.settlementChain,
          recipient: quote.settlementRecipient,
          summary: quote.summary,
          expiresAt: quote.expiresAt,
          terms,
        },
        checks: {
          withinCeiling,
          ceiling: ceiling === null ? null : formatMoney(ceiling),
          assetConfirmedForChain: confirmed,
          // Stated positively from the terms the adapter recorded, rather than inferred from an absence.
          shippingRequired: terms.shippingRequired === true,
          contactRequired: terms.contactRequired === true,
        },
        requestHash: `0x${createHash("sha256")
          .update(stableStringify(request as Readonly<Record<string, unknown>>))
          .digest("hex")}`,
        environment,
        productionStore: isProduction,
        operatorKeyId: auth.operatorKeyId,
        note:
          "This is a price, not an intent. Nothing was created, reserved, queued or paid; no signer was " +
          "loaded and no proof gate was touched. The price came from the provider's own unpaid 402 " +
          "challenge on the endpoint the execution would pay.",
      });
    })().catch((err: unknown) => {
      /**
       * Classified, never handed to express.
       *
       * A preview exists to surface a provider defect cheaply, so answering one with an HTML 500 would
       * defeat its only purpose.
       */
      const classified = classifyFailure(err);
      res.status(classified.status).json({
        code: classified.code,
        message: classified.message,
        stage: "QUOTE_PREVIEW",
        disposition: classified.disposition,
        retryable: classified.retryable,
        created: false,
        reserved: false,
        settled: false,
        docsUrl: null,
      });
      void next;
    });
  });
}
