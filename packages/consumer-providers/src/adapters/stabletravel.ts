/**
 * StableTravel — flight DISCOVERY. Not booking.
 *
 * This adapter exists partly to be correct about what a provider is not.
 *
 * `deep-research-report (4).md` line 41 says StableTravel offers "74 endpoints … for flight offers,
 * hotels, activities, transfers, and real-time flight tracking … and end-to-end booking and
 * cancellation flows". The live OpenAPI, fetched 2026-07-27, says otherwise, in its own words:
 *
 *   "StableTravel is a flight data API. It returns prices, award availability, booking links, and
 *    operational data. It does **not** issue tickets, hold reservations, or take payment for travel —
 *    booking happens on the airline or OTA page that /api/google-flights/booking links to. There are
 *    no hotel, activity, or ground-transfer endpoints."
 *
 * 45 paths, zero booking paths. So `quote`/`execute` here are not "not implemented yet" — they are
 * `CAPABILITY_UNAVAILABLE` by the provider's own design, and the Untch Travel service says so rather
 * than implying a booking that no integrated provider can perform.
 *
 * What IS real: `GET /api/google-flights/search` ($0.02) returns live cash fares with `price_insights`,
 * and `GET /api/google-flights/booking` ($0.02) returns the airline/OTA links a traveller actually
 * books through. Governed comparison shopping is a genuine service. Governed booking is not available
 * from this provider, and the honest thing is to ship the first and refuse the second.
 */

import {
  hashQuote,
  newDiscoveryId,
  normalizedError,
  ProviderError,
  type DeliveryEvidence,
  type DiscoveryInput,
  type DiscoveryResult,
  type ExecuteInput,
  type PaymentCapability,
  type ProviderExecution,
  type ProviderQuote,
  type ProviderReference,
  type ProviderStatus,
  type QuoteInput,
} from "@untch/consumer-core";
import { BaseAdapter, type AdapterContext, type ProviderCapabilityDescriptor } from "../adapter";
import { arr, decimalString, dig, obj, optStr, str, validated } from "../schema";

export const STABLETRAVEL_BASE_URL = "https://stabletravel.dev";

const IATA_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class StableTravelAdapter extends BaseAdapter {
  readonly providerId = "stabletravel";

  constructor(baseUrl: string = STABLETRAVEL_BASE_URL) {
    super(baseUrl);
  }

  capabilities(): readonly ProviderCapabilityDescriptor[] {
    // travel.quote / travel.book are deliberately ABSENT. A capability this provider cannot perform
    // must not appear in the registry at all — the gate is "does anyone declare it", and a declared
    // capability that throws would make the registry lie.
    return [
      { capability: "travel.search", description: "live cash fares via Google Flights", movesValue: false },
      { capability: "travel.compare", description: "booking options and prices for one itinerary", movesValue: false },
    ];
  }

  protected override healthPath(): string {
    return "/api/health";
  }

  /** GET /api/google-flights/search — $0.02. */
  async discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult> {
    const origin = str(input.params.origin ?? input.params.departure_id, "params.origin", 8).toUpperCase();
    const destination = str(
      input.params.destination ?? input.params.arrival_id,
      "params.destination",
      8,
    ).toUpperCase();
    const outbound = str(input.params.departureDate ?? input.params.outbound_date, "params.departureDate", 16);
    const returnDate = optStr(input.params.returnDate ?? input.params.return_date, "params.returnDate", 16);

    if (!IATA_RE.test(origin) || !IATA_RE.test(destination)) {
      throw new ProviderError(
        normalizedError("PROVIDER_BAD_REQUEST", "`origin` and `destination` must be 3-letter IATA codes"),
      );
    }
    if (!DATE_RE.test(outbound) || (returnDate !== null && !DATE_RE.test(returnDate))) {
      throw new ProviderError(
        normalizedError("PROVIDER_BAD_REQUEST", "dates must be YYYY-MM-DD"),
      );
    }

    const qs = new URLSearchParams({
      departure_id: origin,
      arrival_id: destination,
      outbound_date: outbound,
      // type 1 = round trip, 2 = one way (per the live spec).
      type: returnDate === null ? "2" : "1",
    });
    if (returnDate !== null) qs.set("return_date", returnDate);
    if (typeof input.params.adults === "number") qs.set("adults", String(input.params.adults));
    if (typeof input.params.travelClass === "number") qs.set("travel_class", String(input.params.travelClass));

    const result = await this.paid(
      {
        method: "GET",
        path: `/api/google-flights/search?${qs.toString()}`,
        ...(ctx.discoveryPayment ? { payment: ctx.discoveryPayment } : {}),
      },
      ctx,
    );

    const body = validated("StableTravel search", () => obj(result.json, "search"));
    const best = validated("StableTravel best_flights", () =>
      [
        ...arr(body.best_flights ?? [], "search.best_flights"),
        ...arr(body.other_flights ?? [], "search.other_flights"),
      ].map((f, i) => {
        const o = obj(f, `flights[${i}]`);
        const legs = arr(o.flights ?? [], `flights[${i}].flights`);
        const firstLeg = legs.length > 0 ? obj(legs[0], `flights[${i}].flights[0]`) : {};
        return {
          price: o.price === undefined || o.price === null ? null : decimalString(o.price, `flights[${i}].price`),
          token: optStr(o.departure_token, `flights[${i}].departure_token`, 4096),
          airline: optStr(dig(firstLeg, "airline"), `flights[${i}].airline`, 120),
          durationMin: typeof o.total_duration === "number" ? o.total_duration : null,
          stops: Math.max(0, legs.length - 1),
        };
      }),
    );

    return {
      providerId: this.providerId,
      discoveryId: newDiscoveryId(),
      options: best.slice(0, input.limit).map((f, i) => ({
        // The departure_token is what /api/google-flights/booking needs. It is the only usable handle.
        providerRef: f.token ?? `offer-${i}`,
        title: `${origin} → ${destination}${f.airline === null ? "" : ` · ${f.airline}`}`,
        description:
          `${f.stops === 0 ? "nonstop" : `${f.stops} stop${f.stops === 1 ? "" : "s"}`}` +
          (f.durationMin === null ? "" : ` · ${Math.floor(f.durationMin / 60)}h${f.durationMin % 60}m`),
        // Cash fares are quoted in the traveller's currency by a third party. They are indicative
        // information, not an amount Untch could ever settle, because this provider takes no payment
        // for travel at all.
        indicativePrice: null,
        imageUrl: null,
        attributes: {
          listedPrice: f.price,
          airline: f.airline,
          stops: f.stops,
          durationMinutes: f.durationMin,
          bookingToken: f.token,
        },
      })),
      truncated: best.length > input.limit,
      retrievedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  async quote(_input: QuoteInput, _ctx: AdapterContext): Promise<ProviderQuote> {
    throw new ProviderError(
      normalizedError(
        "CAPABILITY_UNAVAILABLE",
        "StableTravel is a flight DATA provider. Its own API guidance states it does not issue " +
          "tickets, hold reservations, or take payment for travel, so there is nothing to quote " +
          "against. Governed booking needs a provider that actually sells inventory.",
      ),
    );
  }

  async execute(
    _input: ExecuteInput,
    _payment: PaymentCapability,
    _ctx: AdapterContext,
  ): Promise<ProviderExecution> {
    throw new ProviderError(
      normalizedError(
        "CAPABILITY_UNAVAILABLE",
        "StableTravel cannot book. Refusing to spend against a provider that does not sell the thing " +
          "being bought.",
      ),
    );
  }

  async getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus> {
    return {
      reference: ref.reference,
      state: "UNKNOWN",
      detail: "StableTravel holds no bookings, so there is no booking status to report",
      raw: {},
      checkedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  async verifyDelivery(exec: ProviderExecution, _ctx: AdapterContext): Promise<DeliveryEvidence> {
    const attested = {
      status: exec.providerStatus,
      reference: exec.providerReference,
      attestedAt: exec.acknowledgedAt,
      fields: exec.payload,
    };
    return {
      intentId: "",
      providerId: this.providerId,
      providerAttested: attested,
      untchVerified: {
        verified: false,
        method: "NONE",
        detail: "no fulfilment occurs through this provider; there is nothing to verify",
        verifiedAt: null,
      },
      evidenceHash: hashQuote({ attested }),
    };
  }
}
