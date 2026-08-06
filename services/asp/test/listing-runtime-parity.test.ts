import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createSellerApp } from "../src/server";
import { SERVICES, serviceById } from "../src/registry/services";
import { buildListingPayload } from "../src/registry/listing";
import { decodeChallenge, startFacilitatorStub, type FacilitatorStub } from "./fixtures/facilitator-stub";

/**
 * The listing and the running service, checked against each other.
 *
 * WHY THIS SUITE EXISTS
 *
 * Every other test here reads the registry. The registry is a TypeScript object, and an object can
 * say `$0.05` while the Express route table charges `$0.50`, because the two are written in
 * different files and nothing compared them. The cold relisting audit found the same service
 * contract described in six places with only one of them enforced; this is the check that the
 * described price and the charged price are the same number.
 *
 * It runs against the real app so the thing being read is the actual `PAYMENT-REQUIRED` header the
 * SDK emits, not a re-derivation of what it ought to contain.
 *
 * A local facilitator stub answers the SDK's supported-kinds discovery call, which it needs before
 * it can produce any challenge at all. `verify` and `settle` are left unmounted, so nothing here can
 * complete a payment even by accident.
 */

const PAY_TO = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";
const USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

const CONFIG = {
  okxApiKey: "test-api-key",
  okxSecretKey: "test-secret-key",
  okxPassphrase: "test-passphrase",
  payTo: PAY_TO as `0x${string}`,
  port: 0,
};

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

const LISTING = buildListingPayload({
  baseUrl: "https://asp.untch.xyz",
  network: "eip155:196",
  name: "Untch",
});

const LISTED_PAID = LISTING.service.filter((e) => serviceById(e.toolId)!.pricing.kind === "paid");
const LISTED_FREE = LISTING.service.filter((e) => serviceById(e.toolId)!.pricing.kind === "free");

async function callListed(entry: (typeof LISTING.service)[number]): Promise<Response> {
  const service = serviceById(entry.toolId)!;
  const url = `${baseUrl}${service.path}`;
  if (service.method === "GET") return fetch(url);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(service.validExample.request),
  });
}

describe("the listing and the running service agree", () => {
  /** A listing with nothing in it would make every assertion below vacuously true. */
  test("the listing is not empty and splits into paid and free", () => {
    assert.equal(LISTED_PAID.length, 6);
    assert.equal(LISTED_FREE.length, 3);
  });

  test("every listed paid route challenges at exactly the listed price", async () => {
    for (const entry of LISTED_PAID) {
      const service = serviceById(entry.toolId)!;
      const res = await callListed(entry);
      assert.equal(res.status, 402, `${entry.toolId} did not ask to be paid`);

      const challenge = decodeChallenge(res.headers.get("payment-required"));
      const accepted = challenge.accepts[0]!;
      assert.equal(
        accepted.amount,
        service.pricing.amountBaseUnits,
        `${entry.toolId}: charges ${accepted.amount} but the registry says ${service.pricing.amountBaseUnits}`,
      );
      assert.equal(accepted.network, "eip155:196", entry.toolId);
      assert.equal(accepted.asset, USDT0, entry.toolId);
      assert.equal(accepted.payTo, PAY_TO, entry.toolId);
      assert.equal(accepted.scheme, "exact", entry.toolId);
      // The authorization is bound to the resource it was issued for, so it cannot be spent elsewhere.
      assert.equal(challenge.resource.url, `${baseUrl}${service.path}`, entry.toolId);
    }
  });

  /**
   * A free entry that answers 402 is the worst kind of listing error: the caller is told a service
   * costs nothing and is then billed, which no amount of correct documentation repairs.
   */
  test("no listed free route asks for payment", async () => {
    for (const entry of LISTED_FREE) {
      const res = await callListed(entry);
      assert.notEqual(res.status, 402, `${entry.toolId} is listed free and asked to be paid`);
      assert.equal(res.headers.get("payment-required"), null, entry.toolId);
    }
  });

  /**
   * Reachability, checked by calling rather than by trusting the route table.
   *
   * A listed route with no handler answers 404 through the same JSON error shape as a refusal, so a
   * caller reading only the body could not tell "this service does not exist" from "your input was
   * wrong". The status is what distinguishes them.
   */
  test("every listed free route returns its real result to a documented request", async () => {
    for (const entry of LISTED_FREE) {
      const res = await callListed(entry);
      assert.equal(res.status, 200, `${entry.toolId} did not answer its own valid example`);
      const body = await res.json();
      assert.ok(body && typeof body === "object", entry.toolId);
    }
  });

  /**
   * The routes deliberately kept OUT of the listing must also be unable to charge.
   *
   * Absence from a listing is not a control — the payment middleware never reads the listing. This
   * asserts the two agree by calling every non-listed service and refusing to see a challenge.
   */
  test("nothing outside the listing emits a payment challenge", async () => {
    const listed = new Set(LISTING.service.map((e) => e.toolId));
    for (const service of SERVICES) {
      if (listed.has(service.toolId)) continue;
      // Path parameters are not URLs; substituted so the probe is a request a caller could send.
      const path = service.path.replace(/\{[A-Za-z0-9_]+\}|:[A-Za-z0-9_]+/g, "probe");
      const res =
        service.method === "GET"
          ? await fetch(`${baseUrl}${path}`)
          : await fetch(`${baseUrl}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(service.validExample.request),
            });
      assert.notEqual(res.status, 402, `${service.toolId} is not listed and still charges`);
      assert.equal(res.headers.get("payment-required"), null, service.toolId);
    }
  });
});
