/**
 * Who owns the right to write to the production database, which is NOT the same question as whether
 * this deployment may spend money.
 *
 * WHY TWO GATES AND NOT ONE
 *
 * `UNTCH_FINANCIAL_ARMED` answers "may this deployment authorise or move money". The writer gate
 * answers "is this deployment the process that owns production writes". They come apart in exactly the
 * situation this migration is in:
 *
 *   Railway is the writer. The Worker is deployed, healthy, connected to the SAME database, and
 *   financially disarmed. A reconciliation sweep is not a financial authorisation — it updates
 *   payment state, finalises service calls and expires reservations — so the arming gate does not
 *   stop it. And a sweep running on Cloudflare against rows Railway also owns is a split brain on the
 *   money path, with no way afterwards to say which process was right.
 *
 * So a single boolean would have to mean both things, and whichever meaning got chosen would leave the
 * other hole open. Two gates, and a mutation needs both.
 *
 * WHAT STAYS OPEN WHILE THE WRITER GATE IS OFF
 *
 * Reads. Health, schema verification, queue-depth inspection, catalog, discovery. A Worker that cannot
 * answer whether it is healthy is one nobody can safely cut over TO, so the gate is deliberately not a
 * blanket refusal.
 */

/**
 * The exact value that transfers write ownership. Nothing else does.
 *
 * Not a truthy check, for the same reason as the arming flag: "false", "0" and "no" all read as true
 * to a loose parser, and the safer reading of an ambiguous value is the one that refuses. This is the
 * control standing between two processes writing one ledger.
 */
export const WRITER_ACTIVE_VALUE = "1" as const;

export type WriterMode = "OWNS_WRITES" | "READ_ONLY";

export interface WriterGate {
  readonly mode: WriterMode;
  readonly ownsWrites: boolean;
  /** Set when write ownership is refused, for an operator reading health. */
  readonly reason: string | null;
}

export function writerGate(flag: string | undefined): WriterGate {
  const ownsWrites = flag?.trim() === WRITER_ACTIVE_VALUE;
  return {
    mode: ownsWrites ? "OWNS_WRITES" : "READ_ONLY",
    ownsWrites,
    reason: ownsWrites ? null : "another deployment owns production writes (UNTCH_PRODUCTION_WRITER_ACTIVE is not 1)",
  };
}

/**
 * Every mutation a scheduled job or queue consumer can perform.
 *
 * Named individually rather than covered by a blanket "write" so a refusal says WHAT was refused, and
 * so adding a new mutating job requires adding it here — the list is the inventory.
 */
export const GATED_MUTATIONS = [
  "payment-reconciliation-write",
  "service-call-finalisation-write",
  "approval-expiry-mutation",
  "reservation-expiry-mutation",
  "delivery-publication",
  "delivery-claim",
  "outbox-recovery-publication",
  "receipt-persistence",
  "treasury-observation-persistence",
  "operational-snapshot-row",
] as const;

export type GatedMutation = (typeof GATED_MUTATIONS)[number];

export class WriterGateClosedError extends Error {
  constructor(
    readonly mutation: GatedMutation,
    readonly reason: string,
  ) {
    super(`refusing ${mutation}: ${reason}`);
    this.name = "WriterGateClosedError";
  }
}

/** Call before any mutation. Throws while another deployment owns writes. */
export function assertOwnsWrites(gate: WriterGate, mutation: GatedMutation): void {
  if (!gate.ownsWrites) throw new WriterGateClosedError(mutation, gate.reason ?? "not the production writer");
}

/**
 * Run a mutation, or record that it was refused.
 *
 * The dry-mode wrapper a scheduled job uses. A refused mutation is not an error: before cutover it is
 * the correct and expected outcome, and a job that threw on it would report itself unhealthy for doing
 * exactly the right thing.
 */
export async function ifOwnsWrites<T>(
  gate: WriterGate,
  mutation: GatedMutation,
  body: () => Promise<T>,
): Promise<{ readonly ran: true; readonly result: T } | { readonly ran: false; readonly refused: GatedMutation }> {
  if (!gate.ownsWrites) return { ran: false, refused: mutation };
  return { ran: true, result: await body() };
}

export interface CutoverPosture {
  readonly financiallyArmed: boolean;
  readonly productionWriter: "cloudflare" | "elsewhere";
  readonly scheduledMutations: "enabled" | "disabled";
  readonly queueMutations: "enabled" | "disabled";
}

/** The posture as an operator and a reviewer should both be able to read it. */
export function cutoverPosture(armed: boolean, gate: WriterGate): CutoverPosture {
  return {
    financiallyArmed: armed,
    productionWriter: gate.ownsWrites ? "cloudflare" : "elsewhere",
    scheduledMutations: gate.ownsWrites ? "enabled" : "disabled",
    queueMutations: gate.ownsWrites ? "enabled" : "disabled",
  };
}
