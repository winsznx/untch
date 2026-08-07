/**
 * Whether this Worker may perform a financial operation, and why it usually may not.
 *
 * THE SITUATION THIS EXISTS FOR
 *
 * During the Cloudflare cutover there are two deployments that can both reach the same data: Railway,
 * which is the writer, and this Worker, which is not yet. A Worker that starts settling payments or
 * creating approvals while Railway is still the writer produces a split brain on the money path —
 * two processes issuing authority against one budget, and no way afterwards to say which one was
 * correct.
 *
 * So arming is EXPLICIT and defaults to off. A Worker that nobody has deliberately armed serves
 * health, public reads and discovery, and refuses anything that would move money or create authority.
 *
 * THREE INDEPENDENT REASONS TO REFUSE
 *
 * Kept separate because they fail for different reasons and a single boolean would hide which:
 *
 *   • UNATTESTED   the bundle cannot prove which commit it is. This is the 2026-07-29 incident: a
 *                  failed build left older code serving while authority was granted on the belief
 *                  that new code was live. An unattested deployment must never be armed.
 *   • SCHEMA       the database is not the one this bundle was built against. Writing financial rows
 *                  against a schema missing a column is how a half-migrated deploy corrupts a ledger.
 *   • NOT_ARMED    the operator has not handed over. This is the cutover switch, and it is the one
 *                  that stays off until Railway stops writing.
 */

import type { SchemaVerdict } from "@untch/consumer-core";

export type ArmingRefusal = "UNATTESTED" | "SCHEMA_NOT_READY" | "NOT_ARMED";

export interface ArmingState {
  readonly armed: boolean;
  readonly refusals: readonly ArmingRefusal[];
  readonly attested: boolean;
  readonly schemaOk: boolean;
  readonly operatorArmed: boolean;
}

export interface ArmingInputs {
  readonly attested: boolean;
  readonly schema: SchemaVerdict | null;
  /**
   * `UNTCH_FINANCIAL_ARMED`. Absent or anything other than the exact string "1" reads as disarmed.
   *
   * Deliberately not a truthy check: "false", "0" and "no" would all arm a loose parser, and the
   * safer reading of an ambiguous value is the one that refuses.
   */
  readonly armedFlag: string | undefined;
}

export function armingState(inputs: ArmingInputs): ArmingState {
  const attested = inputs.attested;
  const schemaOk = inputs.schema?.ok === true;
  const operatorArmed = inputs.armedFlag?.trim() === "1";

  const refusals: ArmingRefusal[] = [];
  if (!attested) refusals.push("UNATTESTED");
  if (!schemaOk) refusals.push("SCHEMA_NOT_READY");
  if (!operatorArmed) refusals.push("NOT_ARMED");

  return { armed: refusals.length === 0, refusals, attested, schemaOk, operatorArmed };
}

/**
 * What a disarmed Worker refuses.
 *
 * An ALLOW-LIST of what stays open would be the wrong shape here: the set of financial operations is
 * small and nameable, while the set of harmless reads grows every time somebody adds a route. Naming
 * the dangerous ones means a new read route is open by default and a new financial route has to be
 * added here deliberately.
 */
export const FINANCIAL_OPERATIONS = [
  "settle-payment",
  "create-approval-request",
  "act-on-approval",
  "create-reservation",
  "consume-reservation",
  "execute-provider-call",
  "write-ledger-entry",
  "mint-x402-authorization",
] as const;

export type FinancialOperation = (typeof FINANCIAL_OPERATIONS)[number];

export class DisarmedError extends Error {
  constructor(
    readonly operation: FinancialOperation,
    readonly refusals: readonly ArmingRefusal[],
  ) {
    super(`refusing ${operation}: this deployment is not armed (${refusals.join(", ")})`);
    this.name = "DisarmedError";
  }
}

/** Call at the top of any financial path. Throws unless every arming condition holds. */
export function assertArmed(state: ArmingState, operation: FinancialOperation): void {
  if (!state.armed) throw new DisarmedError(operation, state.refusals);
}

/** The refusal a caller sees. 503, because this is a deployment posture rather than their mistake. */
export function disarmedResponse(err: DisarmedError): Response {
  return new Response(
    JSON.stringify({
      code: "DEPLOYMENT_NOT_ARMED",
      message: "this deployment does not perform financial operations",
      operation: err.operation,
      refusals: err.refusals,
      retryable: false,
      docsUrl: null,
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}
