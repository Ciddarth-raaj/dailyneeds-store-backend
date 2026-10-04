/**
 * Payrun Initialization - THE 3-DAY ABSENT REVIEW: who has been absent on
 * their LATEST three applicable working days, as of today.
 *
 * AS OF TODAY, NOT AS OF THE PAYROLL MONTH END. Payroll for September is run
 * around 5 October, and the question HR needs answered then is "has this
 * person stopped coming to work NOW?" - not "how did September end?". So the
 * walk starts at the latest COMPLETED attendance date (yesterday in IST) and
 * crosses month boundaries freely: September's payroll review on 4 October
 * reads 3, 2 and 1 October first. The selected payroll month decides only WHO
 * is reviewed (its payroll population), never which dates are read.
 *
 * A WARNING FOR HR AND NOTHING ELSE. It marks nobody exited, blocks nobody,
 * moves no pay type and writes nothing. Its purpose is to find people who may
 * have stopped coming to work but whose exit nobody has recorded, so that a
 * person looks before payroll is run. Who has an exit record is decided by the
 * caller (`usecase/payrun.js#_absenceReview`); this file never sees anybody
 * who has one.
 *
 * PURE, AND IT CALCULATES NO ATTENDANCE. Every day it reads is a row the
 * attendance engine already stored in `attendance_day_calculation`; the
 * verdict on each date is the engine's. This file walks those stored verdicts
 * backwards from the end of the month and refuses to guess.
 *
 * THE WALK, from the latest completed date backwards - never before the
 * joining date and never more than LOOKBACK_DAYS - one date at a time:
 *
 *   no stored row                   NOT EVALUABLE - attendance not calculated.
 *                                   A missing calculation is not a rest day and
 *                                   not an absence, so the walk does NOT step
 *                                   past it to older dates.
 *   any attendance on the date      NOT ABSENT - a present day ends the run
 *   Present/Absent Only date        NOT EVALUABLE - that mode has no roster,
 *                                   and the system has no other source saying
 *                                   which of its dates were working days. It is
 *                                   NOT assumed that every date is one.
 *   ATTENDANCE_NOT_REQUIRED         skipped - exempt, not expected to attend
 *   NOT_JOINED / EXITED             skipped - outside the employment period
 *                                   (never stored; listed for completeness)
 *   rest day                        skipped - the shift's own weekly schedule,
 *                                   as snapshotted by the engine for that date
 *                                   (`is_working_day = 0`), says it is not a
 *                                   working day
 *   working-day flag unreadable     NOT EVALUABLE
 *   NO_SHIFT_FOR_DATE /
 *   NO_SCHEDULE_ROW                 NOT EVALUABLE - a roster setup fault, not a
 *                                   non-working day (the attendance dashboard
 *                                   treats it as Unresolved for the same reason)
 *   settled ABSENT on a working day counted
 *   anything else (a pending
 *   regularization, a day under
 *   review, not final)              NOT EVALUABLE - an absence somebody has
 *                                   claimed or that is unsettled is not one
 *
 * Three counted absences before any stop: THREE_DAY_ABSENT. Reaching the
 * joining date first: NOT_ABSENT (fewer than three applicable days since
 * joining). Running through LOOKBACK_DAYS with no answer: NOT EVALUABLE.
 */

const REVIEW_DAYS = 3;

/**
 * HOW FAR BACK THE WALK MAY GO. It bounds the one batched read; a roster with
 * fewer than three working days in a whole month is not one this warning can
 * judge, so it says so rather than reaching further.
 */
const LOOKBACK_DAYS = 31;

const EVALUATION = {
  THREE_DAY_ABSENT: "THREE_DAY_ABSENT",
  NOT_ABSENT: "NOT_ABSENT",
  NOT_EVALUABLE: "NOT_EVALUABLE",
};

/** Why an employee's last working days could not be established. */
const NOT_EVALUABLE_REASON = {
  NO_REVIEW_DATE: "NO_REVIEW_DATE",
  LOOKBACK_EXHAUSTED: "LOOKBACK_EXHAUSTED",
  NOT_CALCULATED: "NOT_CALCULATED",
  NO_WORKING_DAY_SOURCE: "NO_WORKING_DAY_SOURCE",
  WORKING_DAY_UNKNOWN: "WORKING_DAY_UNKNOWN",
  NO_SHIFT: "NO_SHIFT",
  UNRESOLVED: "UNRESOLVED",
};

/** Stored verdicts for a date the employee was not expected to attend. */
const NOT_EXPECTED = new Set(["ATTENDANCE_NOT_REQUIRED", "NOT_JOINED", "EXITED"]);
const NO_SHIFT = new Set(["NO_SHIFT_FOR_DATE", "NO_SCHEDULE_ROW"]);

/** `true` / `false` / `null` from whatever the JSON column handed back. */
function workingFlag(value) {
  if (value === null || value === undefined || value === "" || value === "null") return null;
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

const truthy = (v) => v === true || v === 1 || v === "1";

function present(day) {
  return Number(day.attendance_day_count) > 0 || Number(day.punch_count) > 0;
}

/** `YYYY-MM-DD` minus one day. */
function previousDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` minus `n` days. */
function minusDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * THE DATES THE WALK MAY READ, for a review made with `latest_completed` as
 * the last completed attendance date: `[latest_completed - (LOOKBACK_DAYS-1),
 * latest_completed]`. The usecase reads exactly this range.
 */
function reviewWindow(latest_completed) {
  const to = dateOnly(latest_completed);
  if (!to) return null;
  return { from: minusDays(to, LOOKBACK_DAYS - 1), to };
}

function dateOnly(value) {
  const m = value === null || value === undefined ? null : String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * One employee, as of the latest completed attendance date.
 *
 * @param {object[]} days  stored day rows: attendance_date (YYYY-MM-DD),
 *                         status, is_final, punch_count, attendance_day_count,
 *                         attendance_calculation_mode, is_working_day
 * @param {object} options
 * @param {string} options.latest_completed  the last completed attendance
 *                         date (yesterday in IST); the walk starts here
 * @param {string|null} options.joined_on     the walk never goes before it
 */
function absenceReview(days = [], { latest_completed = null, joined_on = null, required = REVIEW_DAYS } = {}) {
  const byDate = new Map();
  (days || []).forEach((d) => {
    const date = d && dateOnly(d.attendance_date);
    if (date) byDate.set(date, d);
  });

  const window = reviewWindow(latest_completed);
  const presentDates = [...byDate.keys()]
    .filter((date) => present(byDate.get(date)) && (!window || date <= window.to))
    .sort();
  const lastPresent = presentDates.length ? presentDates[presentDates.length - 1] : null;
  const absent = [];

  const outcome = (evaluation, extra = {}) => ({
    evaluation,
    three_day_absent: evaluation === EVALUATION.THREE_DAY_ABSENT,
    absent_dates: evaluation === EVALUATION.THREE_DAY_ABSENT ? absent.slice().reverse() : [],
    last_present_date: lastPresent,
    not_evaluable_reason: null,
    not_evaluable_date: null,
    ...extra,
  });
  const notEvaluable = (reason, date) =>
    outcome(EVALUATION.NOT_EVALUABLE, { not_evaluable_reason: reason, not_evaluable_date: date });

  if (!window) return notEvaluable(NOT_EVALUABLE_REASON.NO_REVIEW_DATE, null);
  const joined = dateOnly(joined_on);

  for (let date = window.to; date >= window.from; date = previousDate(date)) {
    if (joined && date < joined) return outcome(EVALUATION.NOT_ABSENT);

    const day = byDate.get(date);
    if (!day) return notEvaluable(NOT_EVALUABLE_REASON.NOT_CALCULATED, date);
    if (present(day)) return outcome(EVALUATION.NOT_ABSENT);
    if (day.attendance_calculation_mode === "PRESENT_ABSENT_ONLY") {
      return notEvaluable(NOT_EVALUABLE_REASON.NO_WORKING_DAY_SOURCE, date);
    }
    if (NOT_EXPECTED.has(day.status)) continue;
    if (NO_SHIFT.has(day.status)) return notEvaluable(NOT_EVALUABLE_REASON.NO_SHIFT, date);

    const working = workingFlag(day.is_working_day);
    if (working === false) continue;
    if (working === null) return notEvaluable(NOT_EVALUABLE_REASON.WORKING_DAY_UNKNOWN, date);

    if (day.status === "ABSENT" && truthy(day.is_final)) {
      absent.push(date);
      if (absent.length >= required) return outcome(EVALUATION.THREE_DAY_ABSENT);
      continue;
    }
    return notEvaluable(NOT_EVALUABLE_REASON.UNRESOLVED, date);
  }

  return notEvaluable(NOT_EVALUABLE_REASON.LOOKBACK_EXHAUSTED, window.from);
}

module.exports = {
  REVIEW_DAYS,
  LOOKBACK_DAYS,
  reviewWindow,
  EVALUATION,
  NOT_EVALUABLE_REASON,
  absenceReview,
  workingFlag,
};
