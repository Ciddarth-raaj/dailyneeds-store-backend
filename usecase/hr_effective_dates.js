/**
 * Stage 0C / C3 — effective-date arithmetic and employment-period boundaries.
 *
 * Pure functions. No database, no clock, no permissions - so the rules that
 * decide whether a transfer is legal can be tested exhaustively, and so that
 * Assignment, Default Shift and Salary cannot each grow their own slightly
 * different answer to the same question.
 *
 * ============================================== THE INTERVAL CONVENTION ==
 *
 *       [effective_from, effective_to)
 *
 * `effective_from` is the first date the row applies. `effective_to` is the
 * first date it does NOT - it is exclusive. `effective_to IS NULL` means the
 * row is current.
 *
 * Why exclusive rather than "last covered date": a replacement then shares
 * exactly one date with the row it replaced, so the boundary is written once
 * and belongs unambiguously to the new row. With inclusive ends, every
 * replacement needs a "minus one day" somewhere, and every one of those is a
 * place to be wrong at a month or year boundary.
 *
 * DATE, never DATETIME. A promotion happens on a day, not at 14:32:07.
 */

/* ------------------------------------------------------------- ISO dates */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date, or null. Deliberately strict: `new Date("today")` is
 * `Invalid Date` and `new Date("2026-02-30")` silently becomes 2 March, so
 * neither is accepted. A date that cannot be parsed exactly is refused rather
 * than guessed - a wrong effective date is a wrong pay period.
 */
function toDate(value) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
      value.getUTCDate()
    ).padStart(2, "0")}`;
  }

  const raw = String(value).trim();
  // A DATETIME from MySQL arrives as "2026-09-01T00:00:00.000Z" or
  // "2026-09-01 00:00:00"; the date part is what matters.
  const head = raw.split("T")[0].split(" ")[0];
  if (!ISO_DATE.test(head)) return null;

  const [y, m, d] = head.split("-").map(Number);
  // Round-trip through UTC to reject 2026-02-30 and friends, which JavaScript
  // would otherwise roll forward into March without complaint.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return head;
}

/** Strict comparison of two ISO dates. ISO strings sort correctly as strings. */
const isBefore = (a, b) => toDate(a) < toDate(b);
const isAfter = (a, b) => toDate(a) > toDate(b);
const isSameDay = (a, b) => toDate(a) === toDate(b);

/* ------------------------------------------------------------- intervals */

/**
 * Does `[from, to)` cover `date`?
 *
 * An open row (to === null) covers every date from `from` onward - including
 * dates in the future, which is correct: today's assignment is what applies
 * next Tuesday unless something replaces it.
 */
function covers(row, date) {
  const d = toDate(date);
  if (!d) return false;
  const from = toDate(row.effective_from);
  const to = toDate(row.effective_to);
  if (!from) return false;
  if (d < from) return false;
  if (to === null) return true;
  return d < to; // exclusive
}

/** Do two half-open intervals share any date? */
function overlaps(a, b) {
  const aFrom = toDate(a.effective_from);
  const aTo = toDate(a.effective_to);
  const bFrom = toDate(b.effective_from);
  const bTo = toDate(b.effective_to);
  if (!aFrom || !bFrom) return false;
  // Half-open: touching at a boundary is NOT an overlap, which is what makes
  // a clean replacement legal.
  const aEndsAtOrBefore = aTo !== null && aTo <= bFrom;
  const bEndsAtOrBefore = bTo !== null && bTo <= aFrom;
  return !(aEndsAtOrBefore || bEndsAtOrBefore);
}

/** The row covering `date`, or null. Voided rows are not history. */
function rowCovering(rows, date) {
  return (rows || []).find((r) => !r.voided_at && covers(r, date)) || null;
}

/** The current row: the one with no end. At most one may exist. */
function currentRow(rows) {
  return (rows || []).find((r) => !r.voided_at && toDate(r.effective_to) === null) || null;
}

/** Live history, newest first. */
function liveRows(rows) {
  return (rows || [])
    .filter((r) => !r.voided_at)
    .sort((a, b) => (toDate(a.effective_from) < toDate(b.effective_from) ? 1 : -1));
}

/* ------------------------------------------------------- the error shape */

class HistoryValidationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = 422;
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------- employment-period boundaries */

/**
 * History may never describe time when the employee was not employed.
 *
 * WHERE THE BOUNDARY IS KNOWN it is enforced exactly. Where it is not - and
 * for 424 of the 629 employees C1 backfilled, `joined_on` is genuinely
 * unknown - the check is SKIPPED rather than satisfied by inventing a date.
 * Fabricating a joining date to make validation pass would put a number in
 * the system that looks like evidence and is not; the whole point of C1's
 * `needs_review` is that unknown stays unknown.
 *
 * @param period  { period_id, period_state, joined_on, ended_on,
 *                  history_locked_through }
 */
function assertWithinPeriod(period, { effective_from, effective_to }, what = "history") {
  if (!period) {
    throw new HistoryValidationError("NO_PERIOD", "This employee has no employment period to attach history to");
  }

  const from = toDate(effective_from);
  const to = toDate(effective_to);

  if (!from) {
    throw new HistoryValidationError("BAD_EFFECTIVE_FROM", "effective_from must be a real calendar date (YYYY-MM-DD)");
  }
  if (effective_to !== null && effective_to !== undefined && effective_to !== "" && !to) {
    throw new HistoryValidationError("BAD_EFFECTIVE_TO", "effective_to must be a real calendar date (YYYY-MM-DD)");
  }
  if (to !== null && to <= from) {
    // The database refuses this too; the message here is the useful one.
    throw new HistoryValidationError(
      "EMPTY_INTERVAL",
      "effective_to is exclusive, so it must be after effective_from - equal dates cover no time at all"
    );
  }

  const joined = toDate(period.joined_on);
  const ended = toDate(period.ended_on);

  if (joined && from < joined) {
    throw new HistoryValidationError(
      "BEFORE_PERIOD_START",
      `${what} cannot start before this employment period began (${joined})`,
      { period_start: joined }
    );
  }

  // An open row means "still applies", which cannot be true of a period that
  // has ended.
  if (period.period_state === "closed" && to === null) {
    throw new HistoryValidationError(
      "OPEN_ROW_ON_CLOSED_PERIOD",
      `${what} cannot be left open on an employment period that has ended`
    );
  }

  if (ended) {
    // `ended_on` is the last day employed; the exclusive bound is the day
    // after. A row may end exactly there, and no later.
    const exclusiveEnd = addDays(ended, 1);
    if (from >= exclusiveEnd) {
      throw new HistoryValidationError(
        "AFTER_PERIOD_END",
        `${what} cannot start after this employment period ended (${ended})`,
        { period_end: ended }
      );
    }
    if (to !== null && to > exclusiveEnd) {
      throw new HistoryValidationError(
        "EXTENDS_PAST_PERIOD_END",
        `${what} cannot extend past the end of this employment period (${ended})`,
        { period_end: ended }
      );
    }
  }

  return true;
}

/** ISO date `days` after `iso`. Used only for boundary arithmetic. */
function addDays(iso, days) {
  const d = toDate(iso);
  if (!d) return null;
  const [y, m, day] = d.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, day + days));
  return toDate(next);
}

/* ---------------------------------------------------------- the lock ---- */

/**
 * Finalized history cannot be rewritten.
 *
 * `history_locked_through` is NULL today and every write checks it anyway, so
 * that the check is exercised long before Attendance and Payroll start
 * advancing it. Once set, a change effective on or before it would rewrite a
 * month somebody has already been paid for; the answer then is an arrears
 * adjustment in Payroll, not an edit here.
 */
function assertNotLocked(period, effective_from, what = "history") {
  const lock = toDate(period && period.history_locked_through);
  if (!lock) return true;

  const from = toDate(effective_from);
  if (from && from <= lock) {
    throw new HistoryValidationError(
      "HISTORY_LOCKED",
      `${what} on or before ${lock} has been finalized and cannot be changed here`,
      { locked_through: lock }
    );
  }
  return true;
}

/* ------------------------------------------------- same-day and overlap - */

/**
 * A second genuine business change on a date that already has one is refused.
 *
 * If HR sets a transfer effective 01-Sep and then enters a different branch
 * effective 01-Sep, the second is not another transfer - nobody moved twice
 * in one day. It is a correction of the first, and it must go through the
 * correction path so the erroneous row is preserved as evidence instead of
 * being buried under a fake event.
 *
 * Allowing it would also create a zero-length row, since closing the first at
 * the second's start date gives [01-Sep, 01-Sep).
 */
function assertNoSameDayBusinessChange(rows, effective_from, what = "change") {
  const from = toDate(effective_from);
  const clash = liveRows(rows).find((r) => isSameDay(r.effective_from, from));
  if (clash) {
    throw new HistoryValidationError(
      "SAME_DAY_CHANGE",
      `There is already a ${what} effective ${from}. If that entry was wrong, correct it - ` +
        "a second value on the same date is a correction, not a second change.",
      { existing_id: clash.assignment_id || clash.shift_history_id || clash.salary_history_id || null }
    );
  }
  return true;
}

/** No live row may overlap the proposed interval. */
function assertNoOverlap(rows, proposed, ignoreIds = []) {
  const ignore = new Set(ignoreIds.filter((id) => id !== null && id !== undefined).map(String));
  const clash = liveRows(rows).find((r) => {
    const id = r.assignment_id || r.shift_history_id || r.salary_history_id;
    if (id !== undefined && ignore.has(String(id))) return false;
    return overlaps(r, proposed);
  });
  if (clash) {
    throw new HistoryValidationError(
      "OVERLAPPING_HISTORY",
      `That period overlaps existing history beginning ${toDate(clash.effective_from)}`,
      { overlaps_from: toDate(clash.effective_from), overlaps_to: toDate(clash.effective_to) }
    );
  }
  return true;
}

/**
 * A replacement closes the current row AT the new row's start date, because
 * the bound is exclusive. Returns what the current row's `effective_to`
 * becomes, or throws when the replacement is not after it.
 */
function closeCurrentAt(current, effective_from) {
  const from = toDate(effective_from);
  if (!current) return null;
  const currentFrom = toDate(current.effective_from);
  if (from <= currentFrom) {
    throw new HistoryValidationError(
      "REPLACEMENT_NOT_AFTER_CURRENT",
      `The current entry began ${currentFrom}; a replacement must be effective after that`,
      { current_from: currentFrom }
    );
  }
  return from;
}

/* ---------------------------------------- the pre-go-live query boundary */

/**
 * THE RULE EVERY CONSUMER MUST FOLLOW, and the reason it is written here
 * rather than left to each caller.
 *
 * A baseline row records what is true NOW. Its `effective_from` is the
 * go-live date because a NOT NULL column needs a value, and its precision is
 * UNKNOWN_BASELINE because nobody knows when it actually began. Reading it
 * backwards - "the baseline says 20,000 from 15-Sep, so July was 20,000
 * too" - invents evidence. July might have been 18,000; the system does not
 * know, and saying so is the only honest answer.
 *
 * Returns the covering row, or an explicit unknown. Never a guess.
 */
function resolveAsOf(rows, date, { goLiveDate = null } = {}) {
  const d = toDate(date);
  if (!d) return { known: false, reason: "BAD_DATE", row: null };

  const row = rowCovering(rows, d);
  if (row) {
    // A baseline row does not vouch for anything before its own start.
    if (row.effective_from_precision === "UNKNOWN_BASELINE" && isBefore(d, row.effective_from)) {
      return { known: false, reason: "NO_AUTHORITATIVE_HISTORY", row: null };
    }
    return { known: true, reason: null, row };
  }

  const goLive = toDate(goLiveDate);
  if (goLive && d < goLive) {
    return { known: false, reason: "BEFORE_GO_LIVE", row: null };
  }
  return { known: false, reason: "NO_AUTHORITATIVE_HISTORY", row: null };
}

module.exports = {
  toDate,
  addDays,
  isBefore,
  isAfter,
  isSameDay,
  covers,
  overlaps,
  rowCovering,
  currentRow,
  liveRows,
  assertWithinPeriod,
  assertNotLocked,
  assertNoSameDayBusinessChange,
  assertNoOverlap,
  closeCurrentAt,
  resolveAsOf,
  HistoryValidationError,
};
