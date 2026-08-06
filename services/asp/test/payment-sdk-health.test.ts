import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { RouteConfig } from "@okxweb3/x402-core/server";
import { createSellerApp } from "../src/server";
import { SERVICES, serviceById } from "../src/registry/services";
import {
  PAYMENT_SDK_HEALTH_ROUTE,
  REQUIRED_ASSET,
  REQUIRED_NETWORK,
  assertPaidRoutesProtected,
  paymentSdkHealth,
  type PaymentSdkHealth,
} from "../src/payment-sdk-health";
import { startFacilitatorStub, type FacilitatorStub } from "./fixtures/facilitator-stub";

/**
 * A dependency in package.json is not proof, and neither is a process-level boolean.
 *
 * `paymentMiddleware` is configured from a table. A route missing from that table is unprotected no
 * matter how many of its neighbours are protected, so the whole point of this check is that no route
 * inherits a green light from the process it shares. The suite is written to fail if it ever could:
 * every negative case below removes or corrupts ONE entry and asserts that exactly that route turns
 * red while the rest stay green.
 */

const PAY_TO = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";

const CONFIG = {
  okxApiKey: "test-api-key",
  okxSecretKey: "test-secret-key",
  okxPassphrase: "test-passphrase",
  payTo: PAY_TO as `0x${string}`,
  port: 0,
};

const PAID_MARKETPLACE = SERVICES.filter(
  (s) => s.classification.serviceClass === "MARKETPLACE_LISTABLE" && s.pricing.kind === "paid",
);

/** A table that is correct by construction, so each test can corrupt exactly one thing about it. */
function goodTable(): Record<string, RouteConfig> {
  const table: Record<string, RouteConfig> = {};
  for (const s of PAID_MARKETPLACE) {
    table[`${s.method} ${s.path}`] = {
      accepts: {
        scheme: "exact",
        network: REQUIRED_NETWORK,
        payTo: PAY_TO,
        price: s.pricing.price!,
      },
      description: s.summary,
      mimeType: "application/json",
    } as RouteConfig;
  }
  return table;
}

function statusOf(health: PaymentSdkHealth, toolId: string): string {
  return health.routes.find((r) => r.toolId === toolId)?.status ?? "absent";
}

describe("per-route SDK protection", () => {
  test("a complete table protects every paid marketplace route", () => {
    const health = paymentSdkHealth({ table: goodTable(), payTo: PAY_TO });
    assert.equal(health.ok, true);
    assert.equal(health.routes.length, PAID_MARKETPLACE.length);
    assert.equal(health.routes.length, 6);
    for (const route of health.routes) assert.equal(route.status, "protected", route.methodPath);
  });

  /** The load-bearing case: one route missing must not be covered by five that are present. */
  test("one missing entry turns exactly that route red", () => {
    const table = goodTable();
    delete table["POST /preflight_payment"];
    const health = paymentSdkHealth({ table, payTo: PAY_TO });
    assert.equal(health.ok, false);
    assert.equal(statusOf(health, "preflight_payment"), "unprotected");
    assert.equal(statusOf(health, "verify_delivery"), "protected");
    assert.equal(statusOf(health, "brand_pack"), "protected");
  });

  test("a price the route table disagrees with is mismatched, and says both numbers", () => {
    const table = goodTable();
    table["POST /preflight_payment"] = {
      ...table["POST /preflight_payment"]!,
      accepts: { scheme: "exact", network: REQUIRED_NETWORK, payTo: PAY_TO, price: "$0.50" },
    } as RouteConfig;
    const health = paymentSdkHealth({ table, payTo: PAY_TO });
    assert.equal(statusOf(health, "preflight_payment"), "mismatched");
    const detail = health.routes.find((r) => r.toolId === "preflight_payment")?.detail ?? "";
    assert.match(detail, /500000/);
    assert.match(detail, /50000/);
  });

  test("the wrong network is mismatched", () => {
    const table = goodTable();
    table["POST /verify_delivery"] = {
      ...table["POST /verify_delivery"]!,
      accepts: { scheme: "exact", network: "eip155:8453", payTo: PAY_TO, price: "$0.10" },
    } as RouteConfig;
    const health = paymentSdkHealth({ table, payTo: PAY_TO });
    assert.equal(statusOf(health, "verify_delivery"), "mismatched");
    assert.equal(statusOf(health, "preflight_payment"), "protected");
  });

  test("a different payee is mismatched", () => {
    const table = goodTable();
    table["POST /verify_delivery"] = {
      ...table["POST /verify_delivery"]!,
      accepts: {
        scheme: "exact",
        network: REQUIRED_NETWORK,
        payTo: "0x000000000000000000000000000000000000dEaD",
        price: "$0.10",
      },
    } as RouteConfig;
    const health = paymentSdkHealth({ table, payTo: PAY_TO });
    assert.equal(statusOf(health, "verify_delivery"), "mismatched");
  });

  /** A checksummed address is the same address, and must not read as a different payee. */
  test("payee comparison ignores address casing", () => {
    const table = goodTable();
    const health = paymentSdkHealth({ table, payTo: PAY_TO.toLowerCase() });
    assert.equal(health.ok, true);
  });

  test("a dynamic price is refused for a service with a published fixed price", () => {
    const table = goodTable();
    table["POST /brand_pack"] = table["POST /builder/brand_pack"]!;
    table["POST /builder/brand_pack"] = {
      ...table["POST /builder/brand_pack"]!,
      accepts: {
        scheme: "exact",
        network: REQUIRED_NETWORK,
        payTo: PAY_TO,
        price: (() => "$0.05") as unknown as string,
      },
    } as RouteConfig;
    const health = paymentSdkHealth({ table, payTo: PAY_TO });
    assert.equal(statusOf(health, "brand_pack"), "mismatched");
  });

  test("the boot assertion throws on an unprotected route and names it", () => {
    const table = goodTable();
    delete table["POST /verify_delivery"];
    const health = paymentSdkHealth({ table, payTo: PAY_TO });
    assert.throws(
      () => assertPaidRoutesProtected(health),
      (err: Error) => err.message.includes("POST /verify_delivery") && err.message.includes("unprotected"),
    );
  });

  test("the boot assertion is silent on a complete table", () => {
    assert.doesNotThrow(() => assertPaidRoutesProtected(paymentSdkHealth({ table: goodTable(), payTo: PAY_TO })));
  });
});

describe("the health route on the real app", () => {
  let server: Server | null = null;
  let facilitator: FacilitatorStub | null = null;
  let baseUrl = "";

  before(async () => {
    facilitator = await startFacilitatorStub();
    process.env.OKX_X402_FACILITATOR_URL = facilitator.url;
    const app = createSellerApp(CONFIG);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no bound port");
    // production-surface-allow: localhost — an ephemeral in-test listener, never a published URL.
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    delete process.env.OKX_X402_FACILITATOR_URL;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (facilitator) await facilitator.close();
  });

  /**
   * Reads the REAL table the middleware was built with, not a reconstruction. If the two ever came
   * apart, this is the assertion that would notice.
   */
  test("the running service reports every paid marketplace route protected", async () => {
    const res = await fetch(`${baseUrl}${PAYMENT_SDK_HEALTH_ROUTE}`);
    assert.equal(res.status, 200);
    const health = (await res.json()) as PaymentSdkHealth;
    assert.equal(health.ok, true);
    assert.equal(health.sdk.middleware, "@okxweb3/x402-express");
    assert.equal(health.sdk.network, REQUIRED_NETWORK);
    assert.equal(health.settlementToken, REQUIRED_ASSET);
    assert.equal(health.routes.length, 6);
    for (const route of health.routes) {
      assert.equal(route.status, "protected", route.methodPath);
      assert.ok(serviceById(route.toolId), route.toolId);
    }
  });

  /** A reviewer checking whether payments are integrated must not be asked to pay to find out. */
  test("the health route is free and reachable without a payment", async () => {
    const res = await fetch(`${baseUrl}${PAYMENT_SDK_HEALTH_ROUTE}`);
    assert.notEqual(res.status, 402);
    assert.equal(res.headers.get("payment-required"), null);
  });

  /** A health document that leaked a facilitator credential would be worse than none. */
  test("the health document names no secret", async () => {
    const body = await (await fetch(`${baseUrl}${PAYMENT_SDK_HEALTH_ROUTE}`)).text();
    for (const secret of [CONFIG.okxApiKey, CONFIG.okxSecretKey, CONFIG.okxPassphrase]) {
      assert.equal(body.includes(secret), false, "the SDK health document leaked a credential");
    }
    for (const word of ["apiKey", "secretKey", "passphrase", "authorization"]) {
      assert.equal(body.toLowerCase().includes(word.toLowerCase()), false, `leaked ${word}`);
    }
  });
});
