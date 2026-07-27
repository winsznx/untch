/**
 * Safe money for the Consumer Pack.
 *
 * The repository already carries two money representations by design: `SpendIntentInput.maxAmount`
 * (bigint base units, hashed into the §8.1 struct) and `SpendIntentInput.amount` (a display `number`
 * the budget rules read). Both are fine where they are — a single-chain, single-token decision input.
 *
 * The Consumer Pack cannot use either. It moves value ACROSS chains and tokens in the same intent
 * (user funds USDT0 on X Layer; the provider is paid USDC on Base or Solana), so an amount that does
 * not carry its own chain, token identity and decimals is not a quantity of money — it is a number
 * that looks like one. Every monetary value here is therefore an integer count of atomic units bound
 * to the asset it counts.
 *
 * Rules enforced by construction:
 *   • No JavaScript float ever holds money. `parseMoney` reads a decimal STRING; `formatMoney` emits
 *     one. There is no `toNumber`.
 *   • Arithmetic between different assets throws `MoneyAssetMismatchError` rather than coercing.
 *   • Rounding is never implicit: `applyBasisPoints` demands an explicit rounding mode.
 */

import type { AssetRef } from "./assets";
import { assetKey, describeAsset } from "./assets";

export interface Money {
  /** Integer count of the asset's smallest unit. Never a float, never a display value. */
  readonly amount: bigint;
  readonly asset: AssetRef;
}

/** Thrown when two amounts of different assets are combined or compared. */
export class MoneyAssetMismatchError extends Error {
  constructor(
    public readonly left: AssetRef,
    public readonly right: AssetRef,
  ) {
    super(
      `money asset mismatch: ${describeAsset(left)} vs ${describeAsset(right)} — ` +
        "amounts on different chains/tokens are not commensurable and are never coerced",
    );
    this.name = "MoneyAssetMismatchError";
  }
}

/** Thrown when a display string is not an exact, in-range decimal for its asset. */
export class MoneyParseError extends Error {
  constructor(
    public readonly input: string,
    reason: string,
  ) {
    super(`cannot parse ${JSON.stringify(input)} as money: ${reason}`);
    this.name = "MoneyParseError";
  }
}

/** Thrown when an operation would produce a negative amount where none is representable. */
export class NegativeMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NegativeMoneyError";
  }
}

export function money(amount: bigint, asset: AssetRef): Money {
  return { amount, asset };
}

export function zeroMoney(asset: AssetRef): Money {
  return { amount: 0n, asset };
}

export function isZero(m: Money): boolean {
  return m.amount === 0n;
}

export function isNegative(m: Money): boolean {
  return m.amount < 0n;
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return assetKey(a) === assetKey(b);
}

function requireSameAsset(a: Money, b: Money): void {
  if (!sameAsset(a.asset, b.asset)) throw new MoneyAssetMismatchError(a.asset, b.asset);
}

export function addMoney(a: Money, b: Money): Money {
  requireSameAsset(a, b);
  return { amount: a.amount + b.amount, asset: a.asset };
}

export function subMoney(a: Money, b: Money): Money {
  requireSameAsset(a, b);
  return { amount: a.amount - b.amount, asset: a.asset };
}

/** Subtraction that refuses to go below zero — for balances and remaining-authority checks. */
export function subMoneyChecked(a: Money, b: Money): Money {
  const out = subMoney(a, b);
  if (out.amount < 0n) {
    throw new NegativeMoneyError(
      `subtracting ${formatMoney(b)} from ${formatMoney(a)} would go negative (${describeAsset(a.asset)})`,
    );
  }
  return out;
}

/** -1 | 0 | 1. Throws on an asset mismatch rather than returning a meaningless ordering. */
export function cmpMoney(a: Money, b: Money): -1 | 0 | 1 {
  requireSameAsset(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export const gtMoney = (a: Money, b: Money): boolean => cmpMoney(a, b) === 1;
export const gteMoney = (a: Money, b: Money): boolean => cmpMoney(a, b) >= 0;
export const ltMoney = (a: Money, b: Money): boolean => cmpMoney(a, b) === -1;
export const lteMoney = (a: Money, b: Money): boolean => cmpMoney(a, b) <= 0;
export const eqMoney = (a: Money, b: Money): boolean => cmpMoney(a, b) === 0;

export function maxMoney(a: Money, b: Money): Money {
  return gteMoney(a, b) ? a : b;
}

export function minMoney(a: Money, b: Money): Money {
  return lteMoney(a, b) ? a : b;
}

export function sumMoney(items: readonly Money[], asset: AssetRef): Money {
  let total = 0n;
  for (const m of items) {
    if (!sameAsset(m.asset, asset)) throw new MoneyAssetMismatchError(asset, m.asset);
    total += m.amount;
  }
  return { amount: total, asset };
}

export type RoundingMode = "FLOOR" | "CEIL";

/**
 * Fee / spread arithmetic in basis points (1 bp = 0.01%). Rounding is REQUIRED, never defaulted:
 * a fee that silently rounds the wrong way is a ledger that silently fails to balance. Callers pick
 * CEIL for what Untch charges and FLOOR for what Untch pays out, so rounding never creates value.
 */
export function applyBasisPoints(m: Money, bps: number, rounding: RoundingMode): Money {
  if (!Number.isInteger(bps) || bps < 0 || bps > 1_000_000) {
    throw new RangeError(`basis points must be an integer in [0, 1000000], got ${bps}`);
  }
  const numerator = m.amount * BigInt(bps);
  const denominator = 10_000n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return { amount: quotient, asset: m.asset };
  // bigint division truncates toward zero; correct it into a true floor/ceil for negative inputs too.
  if (rounding === "CEIL") {
    return { amount: numerator > 0n ? quotient + 1n : quotient, asset: m.asset };
  }
  return { amount: numerator < 0n ? quotient - 1n : quotient, asset: m.asset };
}

const DECIMAL_RE = /^-?(\d+)(?:\.(\d+))?$/;

/**
 * Parse an exact decimal display string into atomic units. Rejects anything that would lose
 * precision — more fractional digits than the asset has decimals is an ERROR, not a silent truncation,
 * because a provider quote of "12.3456789" against a 6-decimal token means the quote was misread.
 */
export function parseMoney(display: string, asset: AssetRef): Money {
  const raw = display.trim();
  if (raw === "") throw new MoneyParseError(display, "empty string");
  const match = DECIMAL_RE.exec(raw);
  if (!match) throw new MoneyParseError(display, "not an exact decimal (no exponent, no separators)");

  const negative = raw.startsWith("-");
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > asset.decimals) {
    throw new MoneyParseError(
      display,
      `${frac.length} fractional digits exceeds ${asset.decimals} for ${describeAsset(asset)} — ` +
        "truncating would silently change the amount",
    );
  }
  const padded = frac.padEnd(asset.decimals, "0");
  const atomic = BigInt(whole + padded);
  return { amount: negative ? -atomic : atomic, asset };
}

/** Exact display rendering. Trailing fractional zeros are kept so the decimals are self-evident. */
export function formatMoney(m: Money): string {
  const negative = m.amount < 0n;
  const abs = negative ? -m.amount : m.amount;
  const s = abs.toString().padStart(m.asset.decimals + 1, "0");
  const cut = s.length - m.asset.decimals;
  const whole = s.slice(0, cut);
  const frac = s.slice(cut);
  const body = m.asset.decimals === 0 ? whole : `${whole}.${frac}`;
  return `${negative ? "-" : ""}${body}`;
}

/** Human/log form: "12.500000 USDC (eip155:8453)". Safe to log — carries no address. */
export function displayMoney(m: Money): string {
  return `${formatMoney(m)} ${m.asset.symbol} (${m.asset.chain})`;
}

/** JSON form for API responses and receipts. Amount stays a STRING so no consumer can float it. */
export interface MoneyJson {
  readonly amount: string;
  readonly display: string;
  readonly token: string;
  readonly contract: string | null;
  readonly chain: string;
  readonly decimals: number;
}

export function moneyToJson(m: Money): MoneyJson {
  return {
    amount: m.amount.toString(),
    display: formatMoney(m),
    token: m.asset.symbol,
    contract: m.asset.address,
    chain: m.asset.chain,
    decimals: m.asset.decimals,
  };
}

export function moneyFromJson(json: MoneyJson, asset: AssetRef): Money {
  if (json.chain !== asset.chain || json.decimals !== asset.decimals) {
    throw new MoneyParseError(
      JSON.stringify(json),
      `asset mismatch: json is ${json.token}@${json.chain}/${json.decimals}dp, expected ${describeAsset(asset)}`,
    );
  }
  if (!/^-?\d+$/.test(json.amount)) {
    throw new MoneyParseError(json.amount, "atomic amount must be an integer string");
  }
  return { amount: BigInt(json.amount), asset };
}
