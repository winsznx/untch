import "server-only";
import {
  PgConsumerStore,
  displayMoney,
  formatMoney,
  money,
  projectBalances,
  type CapabilityRecord,
  type ConsumerIntent,
  type ConsumerQuote,
  type DeliveryEvidence,
  type FundingReceipt,
  type LedgerGroup,
  type PauseFlag,
  type ProviderCapabilityRecord,
  type ProviderExecutionRecord,
  type ProviderRecord,
  type TreasuryAccountRecord,
  type TreasuryBalanceObservation,
} from "@untch/consumer-core";
import { getPool } from "./db";

/**
 * The dashboard's READ view of the Consumer Pack.
 *
 * Same discipline as `lib/dashboard/db.ts`: every read goes through the SAME `PgConsumerStore` the
 * ASP writes with, never a second query implementation. That is what stops the operator surface from
 * drifting into a prettier version of a different truth.
 *
 * Scoping mirrors the rest of the dashboard. A consumer intent's tenant is `policy:<policyId>`, and a
 * policy is owned by a wallet on-chain, so an operator sees exactly the intents belonging to policies
 * they own. An unauthenticated or policy-less operator sees nothing — never a global unscoped read.
 */

function store(): PgConsumerStore | null {
  const pool = getPool();
  return pool ? new PgConsumerStore(pool) : null;
}

export interface ConsumerOverview {
  readonly configured: boolean;
  readonly totals: {
    readonly active: number;
    readonly completed: number;
    readonly manualReview: number;
    readonly blocked: number;
  };
  readonly providers: readonly ProviderSummary[];
  readonly rails: readonly RailSummary[];
  readonly recent: readonly IntentSummary[];
}

export interface ProviderSummary {
  readonly providerId: string;
  readonly displayName: string;
  readonly maturity: ProviderRecord["maturity"];
  readonly protocol: string;
  readonly chains: readonly string[];
  readonly enabled: boolean;
  readonly provenance: string;
  readonly capabilities: readonly ProviderCapabilityRecord[];
  readonly healthy: boolean | null;
  readonly latencyMs: number | null;
  readonly breaker: string | null;
}

export interface RailSummary {
  readonly treasuryRef: string;
  readonly chain: string;
  readonly token: string;
  readonly purpose: string;
  readonly address: string;
  readonly enabled: boolean;
  readonly minBalance: string;
  readonly dailyLimit: string;
  readonly onchain: string | null;
  readonly ledger: string | null;
  readonly drift: string | null;
  readonly observedAt: string | null;
  readonly belowFloor: boolean;
}

export interface IntentSummary {
  readonly intentId: string;
  readonly action: string;
  readonly state: string;
  readonly providerId: string | null;
  readonly total: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureCode: string | null;
}

/** Never render a full address on an operator surface. `0x1234…abcd` is enough to correlate. */
export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "—";
  const t = addr.trim();
  return t.length <= 14 ? t : `${t.slice(0, 6)}…${t.slice(-4)}`;
}

function summarise(i: ConsumerIntent): IntentSummary {
  return {
    intentId: i.intentId,
    action: i.action,
    state: i.state,
    providerId: i.providerId,
    total: i.fundingAmount === null ? null : displayMoney(i.fundingAmount),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    failureCode: i.failureCode,
  };
}

const ACTIVE_STATES = new Set([
  "CREATED", "DISCOVERING", "QUOTED", "POLICY_CHECKING", "AWAITING_APPROVAL", "APPROVED",
  "AWAITING_FUNDING", "FUNDED", "EXECUTION_QUEUED", "PROVIDER_PAYMENT_PENDING", "PROVIDER_PAID",
  "PROVIDER_ACKNOWLEDGED", "DELIVERY_PENDING", "DELIVERY_VERIFIED",
]);

/** Tenant ids an operator may read, derived from the policies they own. */
export function tenantsForPolicies(policyIds: readonly string[]): readonly string[] {
  return policyIds.map((id) => `policy:${id}`);
}

export async function consumerOverview(tenants: readonly string[]): Promise<ConsumerOverview> {
  const s = store();
  if (!s) {
    return {
      configured: false,
      totals: { active: 0, completed: 0, manualReview: 0, blocked: 0 },
      providers: [],
      rails: [],
      recent: [],
    };
  }

  const [providers, treasury] = await Promise.all([s.listProviders(), s.listTreasuryAccounts()]);

  const providerSummaries: ProviderSummary[] = await Promise.all(
    providers.map(async (p) => {
      const [caps, health] = await Promise.all([
        s.listCapabilities(p.providerId),
        s.latestHealth(p.providerId),
      ]);
      return {
        providerId: p.providerId,
        displayName: p.displayName,
        maturity: p.maturity,
        protocol: p.protocol,
        chains: p.chains,
        enabled: p.enabled,
        provenance: p.provenance,
        capabilities: caps,
        healthy: health?.healthy ?? null,
        latencyMs: health?.latencyMs ?? null,
        breaker: health?.breakerState ?? null,
      };
    }),
  );

  const rails: RailSummary[] = await Promise.all(
    treasury.map(async (t) => {
      const obs = await s.latestBalanceObservation(t.treasuryRef);
      return railSummary(t, obs);
    }),
  );

  // Tenant-scoped. An empty tenant list reads as an empty dashboard, not as everything.
  const perTenant = await Promise.all(
    tenants.map((tenantId) => s.listIntents({ tenantId, limit: 200 })),
  );
  const all = perTenant.flat().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return {
    configured: true,
    totals: {
      active: all.filter((i) => ACTIVE_STATES.has(i.state)).length,
      completed: all.filter((i) => i.state === "COMPLETED").length,
      manualReview: all.filter((i) => i.state === "MANUAL_REVIEW").length,
      blocked: all.filter((i) => i.state === "BLOCKED").length,
    },
    providers: providerSummaries,
    rails,
    recent: all.slice(0, 25).map(summarise),
  };
}

function railSummary(t: TreasuryAccountRecord, obs: TreasuryBalanceObservation | null): RailSummary {
  const belowFloor = obs !== null && obs.onchain.amount < t.minBalance.amount;
  return {
    treasuryRef: t.treasuryRef,
    chain: t.asset.chain,
    token: t.asset.symbol,
    purpose: t.purpose,
    address: t.address,
    enabled: t.enabled,
    minBalance: formatMoney(t.minBalance),
    dailyLimit: formatMoney(t.dailyLimit),
    onchain: obs === null ? null : formatMoney(obs.onchain),
    ledger: obs === null ? null : formatMoney(obs.ledger),
    drift: obs === null ? null : formatMoney(obs.drift),
    observedAt: obs?.observedAt ?? null,
    belowFloor,
  };
}

export interface IntentDetail {
  readonly intent: ConsumerIntent;
  readonly quote: ConsumerQuote | null;
  readonly funding: FundingReceipt | null;
  readonly executions: readonly ProviderExecutionRecord[];
  readonly delivery: DeliveryEvidence | null;
  readonly ledger: readonly LedgerGroup[];
  readonly events: readonly { seq: number; name: string; state: string; occurredAt: string }[];
  readonly obligation: string | null;
  readonly approvalOutcome: string | null;
  readonly approvalResolvedBy: string | null;
}

export async function intentDetail(
  tenants: readonly string[],
  intentId: string,
): Promise<IntentDetail | null> {
  const s = store();
  if (!s) return null;

  // Read through the tenant-scoped accessor so a URL cannot be used to read another operator's
  // intent. Trying each owned tenant is the same shape as `ownerAgents` scoping elsewhere.
  let intent: ConsumerIntent | null = null;
  for (const tenantId of tenants) {
    intent = await s.getIntentForTenant(tenantId, intentId);
    if (intent) break;
  }
  if (!intent) return null;

  const [quote, funding, executions, delivery, ledger, events, approval] = await Promise.all([
    intent.quoteId === null ? Promise.resolve(null) : s.getQuote(intent.quoteId),
    s.getFunding(intentId),
    s.listExecutions(intentId),
    s.getDeliveryEvidence(intentId),
    s.ledgerGroupsForIntent(intentId),
    s.eventsSince(intentId, 0, 200),
    s.getApproval(intentId),
  ]);

  let obligation: string | null = null;
  if (intent.fundingAsset !== null) {
    const balances = projectBalances(ledger);
    const key = `USER_OBLIGATION:${intent.fundingAsset.chain}|${(intent.fundingAsset.address ?? "native").toLowerCase()}:${intentId}`;
    const found = balances.get(key);
    obligation = formatMoney(found ?? money(0n, intent.fundingAsset));
  }

  return {
    intent,
    quote,
    funding,
    executions,
    delivery,
    ledger,
    events: events.map((e) => ({ seq: e.seq, name: e.name, state: e.state, occurredAt: e.occurredAt })),
    obligation,
    approvalOutcome: approval?.outcome ?? null,
    approvalResolvedBy: approval?.resolvedBy?.channel ?? null,
  };
}

export interface TreasuryView {
  readonly configured: boolean;
  readonly rails: readonly RailSummary[];
  readonly pauses: readonly PauseFlag[];
  readonly liveCapabilities: readonly CapabilityRecord[];
}

export async function treasuryView(): Promise<TreasuryView> {
  const s = store();
  if (!s) return { configured: false, rails: [], pauses: [], liveCapabilities: [] };
  const [accounts, pauses] = await Promise.all([s.listTreasuryAccounts(), s.listPauses()]);
  const rails = await Promise.all(
    accounts.map(async (t) => railSummary(t, await s.latestBalanceObservation(t.treasuryRef))),
  );
  return { configured: true, rails, pauses, liveCapabilities: [] };
}

export async function manualReviewQueue(tenants: readonly string[]): Promise<readonly IntentSummary[]> {
  const s = store();
  if (!s) return [];
  const perTenant = await Promise.all(
    tenants.map((tenantId) => s.listIntents({ tenantId, state: "MANUAL_REVIEW", limit: 100 })),
  );
  return perTenant
    .flat()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(summarise);
}

export async function providerRegistry(): Promise<readonly ProviderSummary[]> {
  const overview = await consumerOverview([]);
  return overview.providers;
}
