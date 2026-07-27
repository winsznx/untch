/**
 * The adapter registry — the in-process map from a providerId to the code that talks to it.
 *
 * Kept separate from `@untch/consumer-core`'s `ProviderRegistry`, which is the DURABLE, maturity-
 * gated registry backed by Postgres. The two answer different questions and it is worth keeping the
 * distinction sharp:
 *
 *   ProviderRegistry (core)  — "is this provider ALLOWED to execute right now?"  (maturity, pauses,
 *                              circuit breakers, capability declarations — all durable state)
 *   AdapterRegistry (here)   — "which class implements it?"                       (a Map)
 *
 * A provider present here but absent from the durable registry can never execute, because the gate
 * is the durable one. That ordering is deliberate: adding a file to this package must not be enough
 * to make Untch spend money.
 */

import { normalizedError, ProviderError } from "@untch/consumer-core";
import type { ConsumerProviderAdapter } from "./adapter";
import { PurchAdapter } from "./adapters/purch";
import { StableDomainsAdapter } from "./adapters/stabledomains";
import { StableEmailAdapter } from "./adapters/stableemail";
import { StableMerchAdapter } from "./adapters/stablemerch";
import { StableTravelAdapter } from "./adapters/stabletravel";
import { PROVIDER_SEEDS } from "./seed";

export interface AdapterRegistry {
  get(providerId: string): ConsumerProviderAdapter;
  has(providerId: string): boolean;
  all(): readonly ConsumerProviderAdapter[];
}

/**
 * Build the adapter map. Base URLs come from the durable registry when supplied — an operator can
 * point an adapter at a staging host — and fall back to the verified production URL otherwise.
 * Anything not in this switch simply has no implementation and is refused by name.
 */
export function buildAdapterRegistry(
  baseUrls: Readonly<Record<string, string>> = {},
): AdapterRegistry {
  const map = new Map<string, ConsumerProviderAdapter>();

  const add = (adapter: ConsumerProviderAdapter): void => {
    map.set(adapter.providerId, adapter);
  };

  add(new StableDomainsAdapter(baseUrls.stabledomains));
  add(new StableEmailAdapter(baseUrls.stableemail));
  add(new StableTravelAdapter(baseUrls.stabletravel));
  add(new PurchAdapter(baseUrls.purch));
  add(new StableMerchAdapter(baseUrls.stablemerch));

  return {
    get(providerId: string): ConsumerProviderAdapter {
      const adapter = map.get(providerId);
      if (!adapter) {
        throw new ProviderError(
          normalizedError(
            "PROVIDER_NOT_EXECUTABLE",
            `no adapter is implemented for provider '${providerId}'`,
          ),
        );
      }
      return adapter;
    },
    has: (providerId: string) => map.has(providerId),
    all: () => [...map.values()],
  };
}

/**
 * A consistency check run at boot and asserted in the tests: every seeded provider has an adapter,
 * every adapter is seeded, and every capability the seed declares is one the adapter actually
 * implements. Without it, a capability could be advertised in the registry — and therefore routed to
 * — with nothing behind it.
 */
export function assertSeedMatchesAdapters(registry: AdapterRegistry): void {
  const problems: string[] = [];

  for (const seed of PROVIDER_SEEDS) {
    if (!registry.has(seed.provider.providerId)) {
      problems.push(`seeded provider '${seed.provider.providerId}' has no adapter`);
      continue;
    }
    const adapter = registry.get(seed.provider.providerId);
    const declared = new Set(adapter.capabilities().map((c) => c.capability));
    for (const cap of seed.capabilities) {
      if (!declared.has(cap.capability)) {
        problems.push(
          `${seed.provider.providerId}: the seed advertises '${cap.capability}' but the adapter does not implement it`,
        );
      }
    }
  }

  const seeded = new Set(PROVIDER_SEEDS.map((s) => s.provider.providerId));
  for (const adapter of registry.all()) {
    if (!seeded.has(adapter.providerId)) {
      problems.push(`adapter '${adapter.providerId}' is not in the registry seed and can never execute`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`provider seed / adapter mismatch:\n  - ${problems.join("\n  - ")}`);
  }
}
