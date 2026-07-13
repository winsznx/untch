/**
 * Parse the §11 `reconcile_agent_spend` `period` parameter into a concrete half-open UTC window
 * [fromIso, toIso) plus the `uint64 period` code anchored on-chain via `AuditAnchored` (§10.3). Two
 * shapes:
 *   • a day   — "YYYY-MM-DD"  → [00:00Z of that day, 00:00Z of the next day)
 *   • a week  — "YYYY-Www"    → [Monday 00:00Z of that ISO week, +7 days)  (ISO-8601 week date)
 *
 * The on-chain `period` code is the window START as unix SECONDS — deterministic, monotonic across
 * periods, and reversible to the window, so a raw-RPC reader can interpret it without our service.
 */

export type PeriodKind = "day" | "week";

export interface Period {
  readonly kind: PeriodKind;
  /** The input label, normalized (e.g. "2026-07-11" or "2026-W28"). */
  readonly label: string;
  /** Inclusive window start, ISO-8601 UTC. */
  readonly fromIso: string;
  /** Exclusive window end, ISO-8601 UTC. */
  readonly toIso: string;
  /** On-chain `AuditAnchored.period`: window start as unix SECONDS. */
  readonly periodCode: bigint;
}

export class PeriodParseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PeriodParseError";
  }
}

const DAY_MS = 86_400_000;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function periodCodeSeconds(ms: number): bigint {
  return BigInt(Math.floor(ms / 1000));
}

/** UTC ms of 00:00:00Z on the given calendar date, validating the date is real (rejects 2026-02-30). */
function utcMidnight(year: number, month1: number, day: number): number {
  const ms = Date.UTC(year, month1 - 1, day);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month1 - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new PeriodParseError("PERIOD_INVALID_DATE", `not a real calendar date: ${year}-${month1}-${day}`);
  }
  return ms;
}

/** UTC ms of the Monday 00:00Z that starts ISO week `week` of ISO-week-year `year`. */
function isoWeekMonday(year: number, week: number): number {
  if (week < 1 || week > 53) {
    throw new PeriodParseError("PERIOD_INVALID_WEEK", `ISO week must be 01-53, got ${week}`);
  }
  // ISO-8601: week 1 is the week containing the year's first Thursday. Jan 4th is always in week 1.
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7; // 1..7, Monday=1
  const week1Monday = jan4 - (jan4Dow - 1) * DAY_MS;
  const monday = week1Monday + (week - 1) * 7 * DAY_MS;
  // Guard against week 53 in a year that only has 52 (the computed Monday would fall in the next year).
  const backToYear = new Date(monday + 3 * DAY_MS).getUTCFullYear(); // the Thursday of this week
  if (backToYear !== year) {
    throw new PeriodParseError("PERIOD_INVALID_WEEK", `ISO week ${week} does not exist in ${year}`);
  }
  return monday;
}

/** Parse a raw period string. Throws `PeriodParseError` on anything malformed (never guesses). */
export function parsePeriod(raw: unknown): Period {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new PeriodParseError("PERIOD_REQUIRED", "a `period` string is required (e.g. \"2026-07-11\" or \"2026-W28\")");
  }
  const s = raw.trim();

  const day = DAY_RE.exec(s);
  if (day) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const dom = Number(day[3]);
    const from = utcMidnight(year, month, dom);
    const to = from + DAY_MS;
    return { kind: "day", label: s, fromIso: toIso(from), toIso: toIso(to), periodCode: periodCodeSeconds(from) };
  }

  const week = WEEK_RE.exec(s);
  if (week) {
    const year = Number(week[1]);
    const wk = Number(week[2]);
    const from = isoWeekMonday(year, wk);
    const to = from + 7 * DAY_MS;
    return { kind: "week", label: s, fromIso: toIso(from), toIso: toIso(to), periodCode: periodCodeSeconds(from) };
  }

  throw new PeriodParseError(
    "PERIOD_MALFORMED",
    `period "${s}" is neither a day ("YYYY-MM-DD") nor an ISO week ("YYYY-Www")`,
  );
}
