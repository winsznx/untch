import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SETTLEMENT_TOKEN } from "../src/config";
import { buildPaidRouteTable } from "../src/paid-route-table";

const PAY_TO = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";

/** The six MARKETPLACE_LISTABLE paid routes — the ones a stranger can buy and a validator probes. */
const LISTED_ROUTES = [
  "/preflight_payment",
  "/verify_delivery",
  "/detect_duplicate",
  "/redact_payment_metadata",
  "/builder/suggest_names",
  "/builder/brand_pack",
] as const;

/**
 * The token facts a client needs when it does not already know our token.
 *
 * OKX's `agent x402-check` reported against every paid endpoint: "cannot determine token decimals:
 * token-info lookup failed (asset 0x779ded… is not in the task system's supported token list
 * (checked: USDT, USDG)) and the accepts entry does not provide a `decimals` field". USDT0 is not on
 * their list, so without this nothing downstream can turn `10000` into `0.01` — the endpoint
 * validates and settles, but a task-system budget check cannot price it.
 *
 * Confirmed live: publishing it cleared the error on all six and the validator now reports
 * `decimals: 6`, and a real $0.01 settlement afterwards still returned its result.
 */
describe("the challenge says how to read its own amount", () => {
  const table = buildPaidRouteTable({ payTo: PAY_TO, publicBaseUrl: "https://asp.untch.xyz" });

  const listedEntries = Object.entries(table).filter(([key]) =>
    LISTED_ROUTES.some((r) => key.endsWith(` ${r}`)),
  );

  test("every listed entry publishes the settlement token's decimals", () => {
    assert.ok(listedEntries.length > 0);
    for (const [key, config] of listedEntries) {
      const accepts = config.accepts as { extra?: Record<string, unknown> };
      assert.equal(
        accepts.extra?.decimals,
        SETTLEMENT_TOKEN.decimals,
        `${key} publishes no decimals, so a client that does not know USDT0 cannot read the amount`,
      );
    }
  });

  /**
   * The EIP-712 domain reads `extra.name` and `extra.version` by name. If a future change ever spread
   * `extra` into the domain instead, an added key would silently change what a payer signs — so the
   * scheme's own fields must still be the ones that arrive.
   */
  test("adding it does not displace the EIP-712 domain fields the payer signs over", () => {
    for (const [, config] of listedEntries) {
      const accepts = config.accepts as { extra?: Record<string, unknown>; price?: unknown };
      assert.ok(accepts.price, "the money form is kept, so prices are never hand-converted to base units");
      assert.equal(Object.keys(accepts.extra ?? {}).length, 1, "only decimals is added here; name and version come from the scheme");
    }
  });
});
