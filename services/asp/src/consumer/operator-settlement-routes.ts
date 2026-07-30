/**
 * Registering a settlement account WITHOUT registering a way to spend from it.
 *
 *   POST /internal/consumer/settlement-accounts   — record a public authority, attested on chain.
 *   GET  /internal/consumer/settlement-accounts   — what is registered, and how sound each one is.
 *
 * WHY THIS ROUTE EXISTS
 *
 * `initConsumerWiring` registers a treasury account by calling `rail.address()`, which throws unless a
 * private key is loaded. So "a float is registered" could not be true unless "this process can drain
 * that float" was also true. The consequence was visible in production: a funded, attested Solana wallet
 * produced `SETTLEMENT_TREASURY_ABSENT` on every preflight, and the only way to clear it was to install
 * the treasury key — which is the one thing that must not happen until the final arming window.
 *
 * This route breaks that coupling. It takes a PUBLIC authority, reads the chain to find out what that
 * authority actually controls, and writes a durable record. No key is accepted, no key is derived, and
 * no key is required. A signer arriving later is checked AGAINST this record rather than being the thing
 * that creates it.
 *
 * WHAT IT WILL NOT ACCEPT
 *
 * A private key, under any field name — refused by name, and the refusal never echoes the value. A mint,
 * a decimals count, a token program or a token account: every one of those is derived from the registry
 * and the chain, because a route that let a caller name a mint would let whoever holds the operator token
 * attest a float denominated in a token they minted themselves.
 *
 * WHY REPLACEMENT IS HARDER THAN REGISTRATION
 *
 * Changing which authority a rail settles from, while money is in flight against the old one, would
 * reconcile the wrong account and could authorise a payment from a float nobody had checked. So a
 * replacement is refused outright while any reservation, unsettled execution, live proof gate or
 * MANUAL_REVIEW record exists. Registering a NEW account is always allowed; replacing a live one is not.
 */

import type { Express, Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import {
  SETTLEMENT_REGISTRATION_VERSION,
  classifySettlementAccount,
  classifySettlementFunding,
  confirmedAssetsFor,
  formatMoney,
  parseMoney,
  stableStringify,
  type AssetRef,
  type CaipChainId,
  type ConsumerStore,
  type Money,
  type SettlementAccountAttestation,
} from "@untch/consumer-core";
import { ACCEPTED_TOKEN_PROGRAMS, observeSolanaSettlementAccount } from "@untch/consumer-providers";
import { authenticateOperator } from "../internal-auth";
import { rpcHostOf, type DeploymentLifecycle } from "../deployment-info";
import type { ConsumerWiring } from "./wiring";
import { operatorEnvironmentOf } from "./operator-routes";

export const OPERATOR_SETTLEMENT_ROUTE = "/internal/consumer/settlement-accounts" as const;

/** The states that make a replacement unsafe. Each is money or an authority that is still in flight. */
const LIVE_GATE_STATES: ReadonlySet<string> = new Set(["ARMED", "CLAIMED", "MANUAL_REVIEW"]);

export interface SettlementRoutesDeps {
  readonly wiring: ConsumerWiring | null;
  readonly lifecycle: DeploymentLifecycle | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. Production reads the chain; a test supplies what the chain would have said. */
  readonly observe?: typeof observeSolanaSettlementAccount;
}

interface ParsedInput {
  readonly treasuryRef: string;
  readonly chain: CaipChainId;
  readonly assetSymbol: string;
  readonly authority: string;
  readonly role: string;
  readonly minBalanceRaw: string;
  readonly dailyLimitRaw: string;
  readonly expectedTokenBalanceRaw: string | null;
  readonly expectedNativeBalanceRaw: string | null;
  readonly enabled: boolean;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
}

/**
 * Field names that must never appear, whatever they hold.
 *
 * Checked by NAME rather than by inspecting values for key-shaped strings. A value check would have to
 * read the value to reject it, and the one thing this route promises is that it never handles a secret.
 * Rejecting the name means the secret is refused before anything looks at it.
 */
const SECRET_FIELDS = [
  "secretKey",
  "privateKey",
  "secret",
  "keypair",
  "mnemonic",
  "seed",
  "seedPhrase",
  "CONSUMER_TREASURY_SOLANA_SECRET_KEY",
  "CONSUMER_TREASURY_BASE_PRIVATE_KEY",
] as const;

/** Fields the chain and the registry decide. Supplying one is a refusal, never a silent override. */
const DERIVED_FIELDS = [
  "mint",
  "tokenMint",
  "assetAddress",
  "decimals",
  "tokenAccount",
  "tokenProgram",
  "tokenAccountOwner",
  "accountState",
  "delegate",
  "closeAuthority",
  "observedTokenBalance",
  "observedNativeBalance",
] as const;

function str(b: Record<string, unknown>, field: string): string | null {
  const v = b[field];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function parseSettlementInput(
  body: unknown,
): { readonly ok: true; readonly input: ParsedInput } | { readonly ok: false; readonly refusals: readonly Refusal[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, refusals: [{ code: "BAD_BODY", message: "the request body must be a JSON object" }] };
  }
  const b = body as Record<string, unknown>;
  const refusals: Refusal[] = [];

  for (const field of SECRET_FIELDS) {
    if (b[field] !== undefined) {
      refusals.push({
        code: "SECRET_NOT_ACCEPTED",
        message:
          `\`${field}\` was supplied. This route registers a PUBLIC authority and never accepts, ` +
          "derives or stores a key. Remove the field and resend.",
      });
    }
  }
  for (const field of DERIVED_FIELDS) {
    if (b[field] !== undefined) {
      refusals.push({
        code: "FIELD_NOT_ACCEPTED",
        message: `\`${field}\` is read from the registry and the chain and may not be supplied`,
      });
    }
  }
  // A supplied secret is a hard stop. Continuing to validate would mean holding it for longer.
  if (refusals.some((r) => r.code === "SECRET_NOT_ACCEPTED")) return { ok: false, refusals };

  const treasuryRef = str(b, "treasuryRef");
  if (treasuryRef === null || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(treasuryRef)) {
    refusals.push({
      code: "TREASURY_REF_INVALID",
      message: "`treasuryRef` must be 3-61 lowercase alphanumeric-or-hyphen characters",
    });
  }

  const chain = str(b, "chain");
  if (chain === null) refusals.push({ code: "CHAIN_MISSING", message: "`chain` is required (CAIP-2)" });

  const assetSymbol = str(b, "asset");
  if (assetSymbol === null) refusals.push({ code: "ASSET_MISSING", message: "`asset` is required (the token symbol)" });

  const authority = str(b, "authority");
  if (authority === null) {
    refusals.push({
      code: "AUTHORITY_MISSING",
      message: "`authority` is required — the PUBLIC address that holds the float",
    });
  } else if (authority.length > 100 || /[^A-Za-z0-9]/.test(authority)) {
    refusals.push({
      code: "AUTHORITY_MALFORMED",
      message: "`authority` must be a base58 or 0x-hex public address with no separators",
    });
  }

  const role = str(b, "role");
  if (role === null || role.length > 80) {
    refusals.push({ code: "ROLE_MISSING", message: "`role` is required — what this float is for, in words" });
  }

  const minBalanceRaw = str(b, "minBalance");
  if (minBalanceRaw === null) {
    refusals.push({
      code: "MIN_BALANCE_MISSING",
      message: "`minBalance` is required — the floor a payment may not take this float below",
    });
  }
  const dailyLimitRaw = str(b, "dailyLimit");
  if (dailyLimitRaw === null) {
    refusals.push({ code: "DAILY_LIMIT_MISSING", message: "`dailyLimit` is required" });
  }

  if (refusals.length > 0) return { ok: false, refusals };
  if (
    treasuryRef === null || chain === null || assetSymbol === null || authority === null ||
    role === null || minBalanceRaw === null || dailyLimitRaw === null
  ) {
    return { ok: false, refusals: [{ code: "BAD_BODY", message: "the request body is incomplete" }] };
  }

  return {
    ok: true,
    input: {
      treasuryRef,
      chain: chain as CaipChainId,
      assetSymbol,
      authority,
      role,
      minBalanceRaw,
      dailyLimitRaw,
      /**
       * The caller's OWN expectation of the balance, checked against the chain.
       *
       * Optional, and it is not the source of the recorded figure — the chain is. Its only job is to
       * catch the case where an operator is registering a different wallet than the one they funded,
       * which is a typo away at all times and produces a perfectly valid attestation of the wrong float.
       */
      expectedTokenBalanceRaw: str(b, "expectedTokenBalance"),
      expectedNativeBalanceRaw: str(b, "expectedNativeBalance"),
      enabled: b.enabled === true,
    },
  };
}

/** Is anything in flight that a replacement would silently re-point? */
async function replacementBlockers(store: ConsumerStore, chain: CaipChainId): Promise<readonly string[]> {
  const blockers: string[] = [];

  const unsettledStates = [
    "FUNDED",
    "EXECUTION_QUEUED",
    "PROVIDER_PAYMENT_PENDING",
    "PROVIDER_ACKNOWLEDGED",
    "DELIVERY_PENDING",
    "AWAITING_FUNDING",
    "AWAITING_APPROVAL",
  ] as const;
  for (const state of unsettledStates) {
    const rows = await store.listIntents({ state, limit: 1 });
    if (rows.length > 0) {
      blockers.push(`an intent is in ${state} (${rows[0]?.intentId ?? "unknown"}), so money may be in flight`);
    }
  }

  const gates = await store.listSolanaProofGates(50);
  for (const gate of gates) {
    if (LIVE_GATE_STATES.has(gate.state) && gate.scope.chain === chain) {
      blockers.push(`a Solana proof gate for ${gate.scope.intentId} is ${gate.state}`);
    }
  }

  return blockers;
}

function redactAttestation(a: SettlementAccountAttestation): Record<string, unknown> {
  return {
    registrationVersion: a.registrationVersion,
    authority: a.authority,
    tokenAccount: a.tokenAccount,
    tokenProgram: a.tokenProgram,
    tokenAccountOwner: a.tokenAccountOwner,
    mint: a.mint,
    decimals: a.decimals,
    accountState: a.accountState,
    delegate: a.delegate,
    closeAuthority: a.closeAuthority,
    observedTokenBalance: a.observedTokenBalance,
    observedNativeBalance: a.observedNativeBalance,
    observedAt: a.observedAt,
    provenance: a.provenance,
  };
}

export function registerConsumerSettlementRoutes(app: Express, deps: SettlementRoutesDeps): void {
  const env = deps.env ?? process.env;
  const observe = deps.observe ?? observeSolanaSettlementAccount;

  const fail = (res: Response, status: number, code: string, message: string): void => {
    res.status(status).json({ code, message, retryable: false, docsUrl: null });
  };

  const authorised = (req: Request, res: Response): { readonly operatorKeyId: string } | null => {
    const auth = authenticateOperator(req, { route: OPERATOR_SETTLEMENT_ROUTE, env });
    if (!auth.ok) {
      res.status(auth.status).json({
        code: auth.code,
        message: auth.message,
        retryable: auth.code === "OPS_AUTH_THROTTLED",
        docsUrl: null,
      });
      return null;
    }
    return { operatorKeyId: auth.operatorKeyId };
  };

  // ── read ───────────────────────────────────────────────────────────────────
  app.get(OPERATOR_SETTLEMENT_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    if (!authorised(req, res)) return;
    const wiring = deps.wiring;
    if (!wiring) {
      fail(res, 503, "CONSUMER_PACK_NOT_CONFIGURED", "no production store is wired on this instance");
      return;
    }

    (async (): Promise<void> => {
      const accounts = await wiring.store.listTreasuryAccounts();
      res.status(200).json({
        accounts: accounts.map((account) => {
          const soundness = classifySettlementAccount(
            account.attestation,
            account.asset,
            ACCEPTED_TOKEN_PROGRAMS,
          );
          return {
            treasuryRef: account.treasuryRef,
            chain: account.asset.chain,
            asset: account.asset.symbol,
            purpose: account.purpose,
            authority: account.address,
            enabled: account.enabled,
            minBalance: formatMoney(account.minBalance),
            dailyLimit: formatMoney(account.dailyLimit),
            attested: account.attestation !== null && account.attestation !== undefined,
            sound: soundness.sound,
            defects: soundness.defects,
            attestation: account.attestation ? redactAttestation(account.attestation) : null,
          };
        }),
      });
    })().catch(next);
  });

  // ── register ───────────────────────────────────────────────────────────────
  app.post(OPERATOR_SETTLEMENT_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    const auth = authorised(req, res);
    if (!auth) return;
    const wiring = deps.wiring;
    if (!wiring) {
      fail(res, 503, "CONSUMER_PACK_NOT_CONFIGURED", "no production store is wired on this instance");
      return;
    }

    const parsed = parseSettlementInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({
        code: "SETTLEMENT_REQUEST_INVALID",
        message: "the request did not validate",
        refusals: parsed.refusals,
        retryable: false,
        docsUrl: null,
      });
      return;
    }
    const input = parsed.input;

    (async (): Promise<void> => {
      const { isProduction } = operatorEnvironmentOf(env);
      if (!isProduction) {
        fail(res, 409, "NOT_PRODUCTION", "this instance is not running in the production environment");
        return;
      }

      /**
       * The asset comes from the registry's CONFIRMED list, matched on symbol.
       *
       * This is where the mint and decimals are decided. Nothing the caller sent contributes: they named
       * a chain and a symbol, and the registry answers with the one asset it has confirmed for that
       * pair. A caller who names an unregistered token gets a refusal rather than an attestation of
       * whatever they pointed at.
       */
      const candidates = confirmedAssetsFor(input.chain).filter(
        (a) => a.symbol.toUpperCase() === input.assetSymbol.toUpperCase(),
      );
      const asset: AssetRef | undefined = candidates[0];
      if (!asset) {
        fail(
          res,
          409,
          "ASSET_NOT_CONFIRMED",
          `no confirmed '${input.assetSymbol}' is registered on ${input.chain}, so there is no mint to attest against`,
        );
        return;
      }
      if (asset.address === null) {
        fail(
          res,
          409,
          "ASSET_HAS_NO_MINT",
          `the registry records no contract for ${asset.symbol} on ${input.chain}`,
        );
        return;
      }

      let minBalance: Money;
      let dailyLimit: Money;
      try {
        minBalance = parseMoney(input.minBalanceRaw, asset);
        dailyLimit = parseMoney(input.dailyLimitRaw, asset);
      } catch {
        fail(res, 400, "AMOUNT_MALFORMED", "`minBalance` and `dailyLimit` must be exact decimals in the asset");
        return;
      }

      /**
       * A replacement is a different act from a registration, and it is gated harder.
       *
       * `findTreasuryAccount` rather than `getTreasuryAccount`: what matters is whether this chain and
       * asset ALREADY have a settlement account, not whether this particular ref does. Registering a
       * second ref for the same rail with a different authority is the replacement case wearing a new
       * name, and it would leave `findTreasuryAccount` picking arbitrarily between two floats.
       */
      const existing = await wiring.store.findTreasuryAccount(input.chain, asset.symbol, "SETTLEMENT");
      const isReplacement =
        existing !== null &&
        (existing.treasuryRef !== input.treasuryRef || existing.address !== input.authority);
      if (isReplacement) {
        const blockers = await replacementBlockers(wiring.store, input.chain);
        if (blockers.length > 0) {
          res.status(409).json({
            code: "SETTLEMENT_REPLACEMENT_REFUSED",
            message:
              `${asset.symbol} on ${input.chain} already settles from '${existing.treasuryRef}'. Replacing it ` +
              "now would re-point reconciliation and authorisation at a float that nothing in flight was " +
              "checked against.",
            blockers,
            retryable: false,
            docsUrl: null,
          });
          return;
        }
      }

      // ── read the chain ──
      const rpcUrl = env.CONSUMER_SOLANA_RPC_URL?.trim() ?? null;
      if (!input.chain.startsWith("solana:")) {
        fail(
          res,
          400,
          "CHAIN_NOT_SUPPORTED",
          `this route attests Solana settlement accounts; ${input.chain} has no token-account model to read`,
        );
        return;
      }
      if (!rpcUrl) {
        fail(
          res,
          503,
          "RPC_NOT_CONFIGURED",
          "no Solana RPC is configured on this instance, so no attestation can be made",
        );
        return;
      }

      const observed = await observe({ rpcUrl, authority: input.authority, mint: asset.address });

      /**
       * The caller's expectation, checked against what the chain said.
       *
       * A mismatch here is almost always a wallet mix-up, and it is the failure most likely to survive
       * every other check: a valid authority, a valid ATA, a clean state, and the wrong wallet. Refusing
       * on it costs an operator one retry and saves arming a treasury nobody funded.
       */
      const expectations: Refusal[] = [];
      if (input.expectedTokenBalanceRaw !== null) {
        try {
          const expected = parseMoney(input.expectedTokenBalanceRaw, asset);
          if (expected.amount !== observed.tokenBalance) {
            expectations.push({
              code: "EXPECTED_TOKEN_BALANCE_MISMATCH",
              message:
                `the chain reports ${observed.tokenBalance} atomic units for this authority; the request ` +
                `expected ${expected.amount}`,
            });
          }
        } catch {
          expectations.push({
            code: "EXPECTED_TOKEN_BALANCE_MALFORMED",
            message: "`expectedTokenBalance` is not an exact decimal in the asset",
          });
        }
      }
      if (input.expectedNativeBalanceRaw !== null) {
        const lamportsExpected = Math.round(Number(input.expectedNativeBalanceRaw) * 1_000_000_000);
        if (!Number.isFinite(lamportsExpected)) {
          expectations.push({
            code: "EXPECTED_NATIVE_BALANCE_MALFORMED",
            message: "`expectedNativeBalance` must be a decimal count of SOL",
          });
        } else if (observed.lamports < BigInt(lamportsExpected)) {
          expectations.push({
            code: "EXPECTED_NATIVE_BALANCE_SHORTFALL",
            message:
              `the authority holds ${observed.lamports} lamports, under the ${lamportsExpected} the ` +
              "request expected. Rent and the sponsor's account checks need it.",
          });
        }
      }
      if (expectations.length > 0) {
        res.status(409).json({
          code: "SETTLEMENT_OBSERVATION_MISMATCH",
          message: "the chain does not agree with the request about this authority",
          refusals: expectations,
          retryable: false,
          docsUrl: null,
        });
        return;
      }

      const snapshot = deps.lifecycle?.snapshot() ?? null;
      const attestation: SettlementAccountAttestation = {
        registrationVersion: SETTLEMENT_REGISTRATION_VERSION,
        mint: observed.mint,
        // The registry's decimals where the chain reports none — an uninitialised account has no
        // decimals to report, and the classifier needs a comparable value to refuse on the STATE
        // rather than on a spurious decimals mismatch.
        decimals: observed.decimals ?? asset.decimals,
        authority: observed.authority,
        tokenAccount: observed.tokenAccount,
        tokenProgram: observed.tokenProgram,
        tokenAccountOwner: observed.tokenAccountOwner,
        accountState: observed.accountState,
        delegate: observed.delegate,
        closeAuthority: observed.closeAuthority,
        observedTokenBalance: observed.tokenBalance.toString(),
        observedNativeBalance: observed.lamports.toString(),
        observedAt: new Date().toISOString(),
        provenance: {
          source: "internal-operator-api",
          operatorKeyId: auth.operatorKeyId,
          requestHash: `0x${createHash("sha256")
            .update(
              stableStringify({
                treasuryRef: input.treasuryRef,
                chain: input.chain,
                asset: asset.symbol,
                authority: input.authority,
                role: input.role,
                minBalance: input.minBalanceRaw,
                dailyLimit: input.dailyLimitRaw,
              }),
            )
            .digest("hex")}`,
          servingCommit: snapshot?.commit ?? null,
          servingDeploymentId: snapshot?.railwayDeploymentId ?? null,
          rpcHost: rpcHostOf(rpcUrl),
        },
      };

      const soundness = classifySettlementAccount(attestation, asset, ACCEPTED_TOKEN_PROGRAMS);

      /**
       * An unsound account is NOT stored.
       *
       * Storing it and reporting the defects would leave a row that `findTreasuryAccount` returns and
       * that clears `SETTLEMENT_TREASURY_ABSENT`, replacing one clear refusal with a subtler one. A
       * frozen or delegated float is not a settlement account; it is a wallet with a problem.
       */
      if (!soundness.sound) {
        res.status(409).json({
          code: "SETTLEMENT_ACCOUNT_UNSOUND",
          message: "the chain says this authority does not control a clean, spendable float. Nothing was stored.",
          defects: soundness.defects,
          attestation: redactAttestation(attestation),
          retryable: false,
          docsUrl: null,
        });
        return;
      }

      await wiring.store.upsertTreasuryAccount({
        treasuryRef: input.treasuryRef,
        asset,
        purpose: "SETTLEMENT",
        address: input.authority,
        minBalance,
        dailyLimit,
        /**
         * Enabled at the operator's word, defaulting OFF.
         *
         * `enabled` is a kill switch, and a route that turned it on by default would mean registering a
         * float and arming it were one action again — a smaller version of exactly the coupling this
         * route exists to break.
         */
        enabled: input.enabled,
        attestation,
      });

      const stored = await wiring.store.getTreasuryAccount(input.treasuryRef);
      if (!stored) {
        fail(res, 500, "SETTLEMENT_NOT_PERSISTED", "the account did not survive its own write");
        return;
      }

      res.status(201).json({
        treasuryRef: stored.treasuryRef,
        chain: stored.asset.chain,
        asset: stored.asset.symbol,
        role: input.role,
        authority: stored.address,
        enabled: stored.enabled,
        registered: true,
        sound: true,
        signer: "absent-by-design",
        execution: "disabled",
        minBalance: formatMoney(stored.minBalance),
        dailyLimit: formatMoney(stored.dailyLimit),
        attestation: redactAttestation(attestation),
        note:
          "A public authority was registered and attested against the chain. No key was accepted, " +
          "derived or stored, and this record grants no ability to spend: a signer loaded later must " +
          "derive exactly this authority before Solana execution becomes available.",
      });
    })().catch(next);
  });
}

/** Re-exported so the readiness path and the tests agree on what funding means. */
export { classifySettlementFunding };
