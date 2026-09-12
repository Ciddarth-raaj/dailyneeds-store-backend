/**
 * Attendance v2 / A1 - the attendance calculation engine.
 *
 * PURE FUNCTIONS ONLY. No database, no Express, no clock, no timezone. Punches
 * arrive as `YYYY-MM-DD HH:MM:SS` wall-clock strings (which is exactly how
 * `repository/biomax_punch.js` hands them out, via DATE_FORMAT, precisely so
 * no JS `Date` in a server timezone can shift a punch) and are turned into
 * integer minutes here. Everything downstream is integer arithmetic.
 *
 * EXACT MINUTES, THROUGHOUT. There is no 15- or 30-minute attendance rounding
 * anywhere in this file. The only rounding v2 permits is the OT rounding
 * already configured on the Work Shift, and it is applied to OT and to nothing
 * else.
 *
 * WHAT THIS ENGINE DOES NOT DO, on purpose:
 *
 *   - It does not classify a day as Full Day, Half Day or Quarter Day. v2 pays
 *     by attendance day plus a minute-based shortage, and a `missed_clock_in_
 *     treatment` of HALF_DAY on the Work Shift master is legacy configuration
 *     that no longer drives pay. It is preserved on the table; it is not read
 *     here.
 *   - It does not create a monetary penalty for lateness or an early finish.
 *     Late and early minutes are REPORTED as metadata because a manager wants
 *     to see them, and they are deducted nowhere: the shortage is already the
 *     deduction, and charging both would deduct the same minute twice.
 *   - It does not decide whether OT is payable. It produces a CANDIDATE, which
 *     is worth zero rupees until the A3 approval chain finishes.
 *
 * THE PAIRING RULE (A1). Punches are paired chronologically by POSITION: 1st
 * IN, 2nd OUT, 3rd IN, 4th OUT. The device's own IN/OUT flag is deliberately
 * not read - `biomax_punch.io_mode` is documented in the Part 1 schema as "NOT
 * a direction flag", staff routinely press the wrong side of a terminal, and a
 * direction taken from the hardware would make worked minutes depend on user
 * error rather than on time elapsed.
 *
 * THE PHASED BREAK RULE, for a two-punch day:
 *
 *     break_deducted = max(0, min(allowed_break, span - 360))
 *     worked         = span - break_deducted
 *
 * Nobody who was present for six hours or less is charged a break at all, and
 * the charge phases in over the hour after that. The property that matters is
 * that worked minutes NEVER FALL as the span grows - the slope is 1, then 0,
 * then 1 again, and never negative - so staying longer can never pay less.
 *
 * FOUR OR MORE PUNCHES use the evidence instead of the rule: every OUT -> next
 * IN gap is summed and charged, no gap is labelled "the lunch one", and a
 * short total break therefore leaves surplus minutes that may feed OT. A
 * two-punch day can never do that, because there is no OUT/IN evidence that
 * the break was short; see `TWO_PUNCH_OT_NOTE` below.
 */

const MINUTES_PER_DAY = 1440;

/** The phase-in point of the break rule: six hours, in minutes. */
const BREAK_FREE_MINUTES = 360;

/** Bumped whenever a stored calculation would come out differently. */
const CALCULATION_VERSION = 1;

/** Every value `status` can take. A calculation is never left without one. */
const CALC_STATUS = Object.freeze({
  FINAL: "FINAL",
  ABSENT: "ABSENT",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  REGULARIZATION_PENDING: "REGULARIZATION_PENDING",
  OT_PENDING: "OT_PENDING",
  NO_SHIFT_FOR_DATE: "NO_SHIFT_FOR_DATE",
  NO_SCHEDULE_ROW: "NO_SCHEDULE_ROW",
});

/** Why a date needs a human. Empty on a clean day. */
const REVIEW_REASON = Object.freeze({
  MISSING_PUNCH: "MISSING_PUNCH",
  NO_SHIFT_FOR_DATE: "NO_SHIFT_FOR_DATE",
  NO_SCHEDULE_ROW: "NO_SCHEDULE_ROW",
});

/** Where an effective punch came from. Raw is immutable; regularized is not raw. */
const PUNCH_SOURCE = Object.freeze({
  BIOMAX: "BIOMAX",
  IMPORT: "IMPORT",
  REGULARIZED: "REGULARIZED",
});

const TWO_PUNCH_OT_NOTE =
  "Two-punch day: OT is limited to time worked beyond the shift span, because an unused break has no OUT/IN evidence";

/* ------------------------------------------------------------------ time */

/** `YYYY-MM-DD HH:MM:SS` (or ISO with a T) -> minutes since its own midnight. */
function clockMinutes(value) {
  if (value === null || value === undefined) return null;
  const m = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value).trim().slice(10));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  // Seconds are truncated, not rounded: a punch at 09:00:59 is a punch in the
  // 09:00 minute, and rounding it up would invent a minute nobody worked.
  return h * 60 + mi;
}

/** `YYYY-MM-DD` out of a datetime string. */
function datePart(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : null;
}

/** Days between two `YYYY-MM-DD`, by UTC math so no local zone can interfere. */
function dayDelta(fromDate, toDate) {
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = parse(fromDate);
  const b = parse(toDate);
  if (a === null || b === null) return null;
  return Math.round((b - a) / (24 * 3600 * 1000));
}

/**
 * A punch as an absolute minute offset from midnight of the ATTENDANCE date.
 *
 * This is what makes an overnight shift arithmetic rather than special-casing:
 * a 00:30 finish on the following calendar morning, attributed by the cutoff
 * to the previous attendance date, becomes minute 1470, and 1470 - 600 is the
 * same subtraction as any other.
 */
function absoluteMinutes(punch, attendanceDate) {
  const minutes = clockMinutes(punch.io_time);
  if (minutes === null) return null;
  const delta = dayDelta(attendanceDate, datePart(punch.io_time));
  if (delta === null) return null;
  return delta * MINUTES_PER_DAY + minutes;
}

/* -------------------------------------------------------------- grouping */

/**
 * Which attendance date a punch belongs to (A1), from the shift's cutoff.
 *
 * The same rule `biomax/attendanceDate.js` applies at ingest, restated here so
 * a RECALCULATION can reproduce it from the dated shift history rather than
 * from whatever the employee's current shift happens to be. A punch after
 * midnight but before the previous day's cutoff belongs to the previous day:
 * a 10:00-22:00 employee who finishes at 00:30 stays on the shift date.
 *
 * @param {object} input
 * @param {string} input.ioTime `YYYY-MM-DD HH:MM:SS`
 * @param {function} input.readCutoff (dateOnly) => {is_working_day, attendance_day_cutoff}|null
 *   for the PREVIOUS calendar day, resolved through the dated shift history.
 */
function attendanceDateForPunch({ ioTime, readCutoff }) {
  const calendarDate = datePart(ioTime);
  const minutes = clockMinutes(ioTime);
  if (calendarDate === null || minutes === null) return null;

  const previousDate = addDays(calendarDate, -1);
  const previous = readCutoff(previousDate);
  if (!previous) return calendarDate;
  if (!(previous.is_working_day === true || Number(previous.is_working_day) === 1)) {
    // A rest day never claims the following morning's punches.
    return calendarDate;
  }

  const cutoff = cutoffMinutes(previous.attendance_day_cutoff);
  if (cutoff === null) return calendarDate;
  return minutes < cutoff ? previousDate : calendarDate;
}

/** `HH:MM[:SS]` -> minutes since midnight, else null. */
function cutoffMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** `YYYY-MM-DD` plus n days, by UTC math. */
function addDays(dateOnly, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * Punches for one employee/date, chronological, regardless of which terminal
 * recorded them.
 *
 * A store employee who covers a shift at another outlet punches on that
 * outlet's device; the same person at the warehouse punches on one of two
 * terminals there. The punch is the employee's, not the device's, so `dev_id`
 * plays no part in the ordering or the grouping - it is carried through only
 * so the audit trail can still say where each punch happened.
 *
 * Ties are broken on punch id, so two punches recorded in the same minute on
 * two devices always come out in the same order on every recalculation.
 */
function orderPunches(punches, attendanceDate) {
  return (punches || [])
    .map((p) => ({
      punch_id: p.punch_id === undefined ? null : p.punch_id,
      source: p.source || PUNCH_SOURCE.BIOMAX,
      dev_id: p.dev_id === undefined ? null : p.dev_id,
      io_time: p.io_time,
      minute: absoluteMinutes(p, attendanceDate),
    }))
    .filter((p) => p.minute !== null)
    .sort((a, b) => {
      if (a.minute !== b.minute) return a.minute - b.minute;
      const ai = a.punch_id === null ? Number.MAX_SAFE_INTEGER : Number(a.punch_id);
      const bi = b.punch_id === null ? Number.MAX_SAFE_INTEGER : Number(b.punch_id);
      return ai - bi;
    });
}

/* ------------------------------------------------------------------- OT */

/**
 * Shift Management's OT rules, applied in the only order that makes sense.
 *
 * qualify -> floor -> round -> cap.
 *
 * `overtime_minimum_minutes` is a QUALIFYING threshold when
 * `overtime_minimum_threshold_only` is set (work less than it and none counts;
 * work more and every minute counts) and a FLOOR otherwise (work more than it
 * and you are paid at least it). That is exactly what the column comment on
 * `work_shift` says, and the two readings differ by real money, so the flag is
 * honoured rather than guessed at.
 */
function applyOvertimeRules(rawMinutes, snapshot) {
  const raw = Math.max(0, Math.trunc(rawMinutes || 0));
  if (!snapshot || !snapshot.overtime_allowed) return 0;
  if (raw === 0) return 0;

  const minimum = Math.max(0, Math.trunc(snapshot.overtime_minimum_minutes || 0));
  if (raw < minimum) return 0;

  let minutes = snapshot.overtime_minimum_threshold_only ? raw : Math.max(raw, minimum);

  const interval = Math.max(0, Math.trunc(snapshot.overtime_rounding_interval_minutes || 0));
  const method = String(snapshot.overtime_rounding_method || "NONE").toUpperCase();
  if (interval > 0 && method !== "NONE") {
    if (method === "UP") minutes = Math.ceil(minutes / interval) * interval;
    else if (method === "DOWN") minutes = Math.floor(minutes / interval) * interval;
    else if (method === "NEAREST") minutes = Math.round(minutes / interval) * interval;
  }

  const cap = snapshot.maximum_ot_minutes_per_day;
  if (cap !== null && cap !== undefined) minutes = Math.min(minutes, Math.max(0, Math.trunc(cap)));

  return Math.max(0, minutes);
}

/* --------------------------------------------------------- the day itself */

/**
 * Calculate one employee's one attendance date.
 *
 * @param {object} input
 * @param {number} input.employee_id
 * @param {string} input.attendance_date          `YYYY-MM-DD`
 * @param {Array}  input.punches                  RAW punches, as stored
 * @param {Array}  [input.regularized_punches]    APPROVED manual punches only
 * @param {object|null} input.shift                a `buildShiftSnapshot` result
 * @param {string} [input.shift_status]            RESOLUTION_STATUS from A0
 * @param {number|null} [input.break_override_minutes] the employee's special
 *        break, which REPLACES the shift break and therefore changes NRM
 * @param {number|null} [input.approved_ot_minutes] only FINAL APPROVED OT
 * @param {boolean} [input.regularization_pending]
 * @returns {object} the stable output contract - see the README of the fields
 *   at the bottom of this function.
 */
function calculateAttendanceDay(input = {}) {
  const {
    employee_id = null,
    attendance_date = null,
    punches = [],
    regularized_punches = [],
    shift = null,
    shift_status = null,
    break_override_minutes = null,
    approved_ot_minutes = null,
    regularization_pending = false,
  } = input;

  const rawPunches = orderPunches(punches, attendance_date);
  const effectivePunches = orderPunches(
    [...(punches || []), ...(regularized_punches || [])],
    attendance_date
  );

  const base = {
    calculation_version: CALCULATION_VERSION,
    employee_id,
    attendance_date,
    work_shift_id: shift ? shift.work_shift_id : null,
    work_shift_weekly_schedule_id: shift ? shift.work_shift_weekly_schedule_id : null,
    shift_snapshot: shift,
    shift_snapshot_hash: shift ? shift.snapshot_hash : null,
    raw_punch_ids: rawPunches.map((p) => p.punch_id),
    raw_punches: rawPunches,
    effective_punches: effectivePunches,
    punch_count: effectivePunches.length,
    attendance_day_count: 0,
    nrm_minutes: 0,
    span_minutes: 0,
    break_allowance_minutes: 0,
    break_allowance_source: "SHIFT",
    actual_gap_minutes: null,
    break_charged_minutes: 0,
    worked_minutes: 0,
    shortage_minutes: 0,
    late_minutes: null,
    early_exit_minutes: null,
    candidate_ot_minutes: 0,
    raw_ot_minutes: 0,
    approved_ot_minutes: 0,
    ot_rate: shift ? shift.ot_rate : null,
    is_final: false,
    status: CALC_STATUS.REVIEW_REQUIRED,
    review_reasons: [],
    notes: [],
  };

  // A date with no resolvable shift produces no numbers at all. It is never
  // silently calculated against "the shift they are on today" - that is the
  // whole reason A0 exists.
  if (!shift) {
    const reason =
      shift_status === "NO_SCHEDULE_ROW"
        ? REVIEW_REASON.NO_SCHEDULE_ROW
        : REVIEW_REASON.NO_SHIFT_FOR_DATE;
    return {
      ...base,
      status:
        reason === REVIEW_REASON.NO_SCHEDULE_ROW
          ? CALC_STATUS.NO_SCHEDULE_ROW
          : CALC_STATUS.NO_SHIFT_FOR_DATE,
      review_reasons: [reason],
    };
  }

  // The employee's special break override REPLACES the shift break (it does
  // not add to it), and because NRM is span - break, changing it changes the
  // number of minutes the employee owes for the day.
  const overrideGiven =
    break_override_minutes !== null &&
    break_override_minutes !== undefined &&
    Number.isFinite(Number(break_override_minutes));
  const allowedBreak = Math.max(
    0,
    Math.trunc(overrideGiven ? Number(break_override_minutes) : shift.break_minutes || 0)
  );
  const shiftSpan = Math.max(0, Math.trunc(shift.shift_span_minutes || 0));
  const nrm = Math.max(0, shiftSpan - allowedBreak);

  base.break_allowance_minutes = allowedBreak;
  base.break_allowance_source = overrideGiven ? "EMPLOYEE_OVERRIDE" : "SHIFT";
  base.nrm_minutes = nrm;

  // Nobody punched. Absent is a real, final answer: no day counted, and NO
  // shortage either - an absent day is simply not paid, and also charging the
  // whole NRM as a shortage would deduct for a day that was never credited.
  if (effectivePunches.length === 0) {
    return {
      ...base,
      status: CALC_STATUS.ABSENT,
      attendance_day_count: 0,
      is_final: true,
    };
  }

  // Present at all is a whole attendance day (A1): ten minutes counts as one.
  // The shortfall is settled in minutes, separately, and never by downgrading
  // the day to a half.
  base.attendance_day_count = 1;

  const first = effectivePunches[0];
  const last = effectivePunches[effectivePunches.length - 1];
  const span = Math.max(0, last.minute - first.minute);
  base.span_minutes = span;

  // Reported, never charged. See the file header: the shortage already is the
  // deduction, and a separate late penalty would take the same minute twice.
  const shiftIn = timeToMinutes(shift.in_time);
  if (shiftIn !== null) {
    base.late_minutes = Math.max(0, first.minute - shiftIn);
    base.early_exit_minutes = Math.max(0, shiftIn + shiftSpan - last.minute);
  }

  // An odd number of punches means one is missing. Provisional numbers are
  // still produced from the punches that exist, because a manager reviewing
  // the queue needs to see roughly what the day looked like, but the date is
  // NOT final and A4 keeps its shortage and its OT out of payroll until a
  // regularization has been approved all the way through.
  if (effectivePunches.length % 2 === 1) {
    return {
      ...base,
      status: regularization_pending
        ? CALC_STATUS.REGULARIZATION_PENDING
        : CALC_STATUS.REVIEW_REQUIRED,
      review_reasons: [REVIEW_REASON.MISSING_PUNCH],
      is_final: false,
      notes: ["Odd punch count: one punch is missing and the day is not final"],
    };
  }

  let breakCharged;
  let actualGaps = null;
  let otBasis;

  if (effectivePunches.length === 2) {
    breakCharged = Math.max(0, Math.min(allowedBreak, span - BREAK_FREE_MINUTES));
    // No OUT/IN evidence exists, so there is nothing to say the break was
    // short. Surplus from an uncharged break must not become OT; only time
    // genuinely beyond the shift span can.
    otBasis = Math.max(0, span - shiftSpan);
    base.notes.push(TWO_PUNCH_OT_NOTE);
  } else {
    // Every OUT -> next IN gap, summed. No gap is singled out as "the lunch
    // one"; the old separate 15-minute extra-break allowance is cancelled and
    // does not exist here.
    actualGaps = 0;
    for (let i = 1; i + 1 < effectivePunches.length; i += 2) {
      actualGaps += effectivePunches[i + 1].minute - effectivePunches[i].minute;
    }
    breakCharged = actualGaps;
    otBasis = null; // computed from worked vs NRM below
  }

  const worked = Math.max(0, span - breakCharged);
  const shortage = Math.max(0, nrm - worked);
  const surplus = Math.max(0, worked - nrm);

  base.actual_gap_minutes = actualGaps;
  base.break_charged_minutes = breakCharged;
  base.worked_minutes = worked;
  base.shortage_minutes = shortage;

  const rawOt = otBasis === null ? surplus : Math.min(surplus, otBasis);
  base.raw_ot_minutes = rawOt;
  base.candidate_ot_minutes = applyOvertimeRules(rawOt, shift);

  const approved = Math.max(0, Math.trunc(Number(approved_ot_minutes) || 0));
  // Approved OT can never exceed what was actually earned: an approval is a
  // decision about the candidate, not a licence to invent minutes.
  base.approved_ot_minutes = Math.min(approved, base.candidate_ot_minutes);

  if (regularization_pending) {
    base.status = CALC_STATUS.REGULARIZATION_PENDING;
    base.is_final = false;
  } else if (base.candidate_ot_minutes > 0 && base.approved_ot_minutes < base.candidate_ot_minutes) {
    // The date's attendance is settled; only its OT is still waiting. Payroll
    // takes the day and the shortage and pays zero OT.
    base.status = CALC_STATUS.OT_PENDING;
    base.is_final = true;
  } else {
    base.status = CALC_STATUS.FINAL;
    base.is_final = true;
  }

  return base;
}

/** `HH:MM:SS` -> minutes, for the snapshot's own times. */
function timeToMinutes(value) {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

module.exports = {
  MINUTES_PER_DAY,
  BREAK_FREE_MINUTES,
  CALCULATION_VERSION,
  CALC_STATUS,
  REVIEW_REASON,
  PUNCH_SOURCE,
  TWO_PUNCH_OT_NOTE,
  clockMinutes,
  datePart,
  addDays,
  dayDelta,
  absoluteMinutes,
  orderPunches,
  attendanceDateForPunch,
  applyOvertimeRules,
  calculateAttendanceDay,
};
