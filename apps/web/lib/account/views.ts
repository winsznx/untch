import "server-only";
import { aspFetch, getAccountSession, type AccountSession } from "./asp";

/**
 * The reads the approval centre renders from.
 *
 * Every one goes to the ASP over the account bearer rather than to Postgres directly, and that is a
 * deliberate difference from `lib/dashboard/*`, which reads the shared database. The approval surface
 * is about AUTHORITY — whose approval, over which quote, with which digest — and the ASP is the only
 * component that knows what an account is allowed to see. A direct query would have to re-implement
 * that scoping, and a second implementation of an authorisation rule is a second place for it to be
 * wrong.
 *
 * Refusals are returned, not thrown. "Expired", "superseded" and "not yours" are things the page has
 * to SAY, and an exception turns each of them into the same error boundary.
 */

export interface ApprovalSummary {
  readonly approvalRequestId: string;
  readonly state: string;
  readonly displayState: string;
  readonly displayLabel: string;
  readonly amount: string | null;
  readonly asset: string | null;
  readonly provider: string | null;
  readonly capability: string | null;
  readonly policyId: string | null;
  readonly intentId: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedAt: string | null;
  readonly supersededBy: string | null;
}

export interface ApprovalListView {
  readonly authenticated: boolean;
  readonly accountId: string | null;
  readonly executionEnabled: boolean;
  readonly executionNote: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly approvals: readonly ApprovalSummary[];
  readonly refusal: { readonly code: string; readonly message: string } | null;
}

const refusalOf = (status: number, body: Record<string, unknown>): { code: string; message: string } => ({
  code: String(body.code ?? `HTTP_${status}`),
  message: String(body.message ?? "the approval service refused this read"),
});

export async function loadApprovals(state?: string): Promise<ApprovalListView> {
  const session = await getAccountSession();
  if (!session) {
    return {
      authenticated: false,
      accountId: null,
      executionEnabled: false,
      executionNote: null,
      counts: {},
      approvals: [],
      refusal: null,
    };
  }
  const q = state ? `?state=${encodeURIComponent(state)}` : "";
  const res = await aspFetch<Record<string, unknown>>(`/consumer/approvals${q}`, session);
  if (!res.ok) {
    return {
      authenticated: true,
      accountId: session.accountId,
      executionEnabled: false,
      executionNote: null,
      counts: {},
      approvals: [],
      refusal: refusalOf(res.status, res.body),
    };
  }
  return {
    authenticated: true,
    accountId: String(res.body.accountId ?? session.accountId),
    executionEnabled: res.body.executionEnabled === true,
    executionNote: typeof res.body.executionNote === "string" ? res.body.executionNote : null,
    counts: (res.body.counts as Record<string, number>) ?? {},
    approvals: (res.body.approvals as ApprovalSummary[]) ?? [],
    refusal: null,
  };
}

export interface ApprovalDetailView {
  readonly authenticated: boolean;
  readonly detail: Record<string, unknown> | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
}

export async function loadApproval(approvalRequestId: string): Promise<ApprovalDetailView> {
  const session = await getAccountSession();
  if (!session) return { authenticated: false, detail: null, refusal: null };
  const res = await aspFetch<Record<string, unknown>>(
    `/consumer/approvals/${encodeURIComponent(approvalRequestId)}`,
    session,
  );
  return res.ok
    ? { authenticated: true, detail: res.body, refusal: null }
    : { authenticated: true, detail: null, refusal: refusalOf(res.status, res.body) };
}

export interface AccountView {
  readonly authenticated: boolean;
  readonly account: Record<string, unknown> | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  readonly session: AccountSession | null;
}

export async function loadAccount(): Promise<AccountView> {
  const session = await getAccountSession();
  if (!session) return { authenticated: false, account: null, refusal: null, session: null };
  const res = await aspFetch<Record<string, unknown>>("/consumer/account", session);
  return res.ok
    ? { authenticated: true, account: res.body, refusal: null, session }
    : { authenticated: true, account: null, refusal: refusalOf(res.status, res.body), session };
}

export interface PolicyListView {
  readonly authenticated: boolean;
  readonly policies: readonly Record<string, unknown>[];
  readonly defaultPolicyId: string | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
}

export async function loadPolicies(): Promise<PolicyListView> {
  const session = await getAccountSession();
  if (!session) return { authenticated: false, policies: [], defaultPolicyId: null, refusal: null };
  const res = await aspFetch<Record<string, unknown>>("/consumer/policies", session);
  if (!res.ok) {
    return { authenticated: true, policies: [], defaultPolicyId: null, refusal: refusalOf(res.status, res.body) };
  }
  return {
    authenticated: true,
    policies: (res.body.policies as Record<string, unknown>[]) ?? [],
    defaultPolicyId: typeof res.body.defaultPolicyId === "string" ? res.body.defaultPolicyId : null,
    refusal: null,
  };
}

export async function loadPolicy(policyId: string): Promise<{
  readonly authenticated: boolean;
  readonly policy: Record<string, unknown> | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
}> {
  const session = await getAccountSession();
  if (!session) return { authenticated: false, policy: null, refusal: null };
  const res = await aspFetch<Record<string, unknown>>(`/consumer/policies/${encodeURIComponent(policyId)}`, session);
  return res.ok
    ? { authenticated: true, policy: res.body, refusal: null }
    : { authenticated: true, policy: null, refusal: refusalOf(res.status, res.body) };
}

/**
 * The activity case list and one case's timeline.
 *
 * Migration 018 created `activity_cases` and `activity_events`; nothing serves them yet. Rather than
 * render a plausible-looking empty table, these report the gap by name so the page can say what is
 * missing instead of looking finished and being empty.
 */
export interface CaseView {
  readonly authenticated: boolean;
  readonly cases: readonly Record<string, unknown>[];
  readonly timeline: readonly Record<string, unknown>[];
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export async function loadCases(caseId?: string): Promise<CaseView> {
  const session = await getAccountSession();
  if (!session) {
    return { authenticated: false, cases: [], timeline: [], available: false, unavailableReason: null };
  }
  const path = caseId ? `/consumer/cases/${encodeURIComponent(caseId)}` : "/consumer/cases";
  const res = await aspFetch<Record<string, unknown>>(path, session);
  if (res.status === 404 || res.status === 501) {
    return {
      authenticated: true,
      cases: [],
      timeline: [],
      available: false,
      unavailableReason:
        "The case projection is not served yet. Migration 018 created `activity_cases` and `activity_events`; " +
        "the indexer that populates them and the route that reads them are the next slice. Nothing is shown " +
        "here rather than a table that would look complete and be empty.",
    };
  }
  if (!res.ok) {
    return {
      authenticated: true,
      cases: [],
      timeline: [],
      available: false,
      unavailableReason: String(res.body.message ?? "the case service refused this read"),
    };
  }
  return {
    authenticated: true,
    cases: (res.body.cases as Record<string, unknown>[]) ?? [],
    timeline: (res.body.events as Record<string, unknown>[]) ?? [],
    available: true,
    unavailableReason: null,
  };
}
