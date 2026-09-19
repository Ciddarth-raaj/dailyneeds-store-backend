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
 *
 * GRACE IS FORGIVEN FROM THE SHORTAGE. The Work Shift's `late_grace_minutes`
 * and `early_exit_grace_minutes` name how much of a late arrival or an early
 * finish is tolerated. Because the shortage is the only deduction, a grace
 * that was never subtracted from it would be a grace in name only: arriving
 * two minutes late on a ten-minute grace would still cost two minutes. So
 * `applyGrace` takes the forgiven minutes off the shortage, and off nothing
 * else - worked minutes, surplus and OT are untouched, so a forgiven minute
 * can never turn into paid overtime.
 *
 * THE INTERVAL DEDUCTION RULE, when the shift configures one. "Deduct D
 * minutes for every started I minutes of lateness" replaces the one-for-one
 * charge for the late minutes the shortage contains (and likewise for early
 * out). It is still settled INSIDE the shortage - the same field payroll
 * already prices - never as a second deduction beside it, and the day's
 * shortage is capped at NRM.
 *   - It does not decide whether OT is payable. It produces a CANDIDATE, which
 *     is worth zero rupees until the A3 approval chain finishes.
 *
 * THE OT RULES IT DOES READ, all of them, from Shift Management and nowhere
 * else. Post-shift OT (`overtime_allowed`, `overtime_minimum_minutes`,
 * `overtime_minimum_threshold_only`, `overtime_rounding_method`,
 * `overtime_rounding_interval_minutes`), PRE-shift OT (the four
 * `pre_shift_overtime_*` columns), the per-day cap
 * (`maximum_ot_minutes_per_day`), the weekday `ot_rate`, and the two OFFSET
 * switches `late_offset_against_overtime` and
 * `early_exit_offset_against_overtime`.
 *
 * THE OFFSETS ARE NOT A DEDUCTION. When Shift Management says lateness offsets
 * overtime, late minutes are subtracted FROM THE OVERTIME and from nothing
 * else; OT can never be driven below zero and no rupee is ever taken for the
 * same minute twice. v2 has no monetary late or early-exit penalty, and these
 * two switches do not create one.
 *
 * PRE-SHIFT TIME IS NOT OVERTIME BY DEFAULT. Turning up an hour early is not
 * an instruction to work, so minutes before the shift's own in-time become OT
 * only when `pre_shift_overtime_allowed` is set AND they qualify under the
 * pre-shift minimum. With the flag off they are excluded from the candidate
 * entirely rather than falling through into the post-shift figure.
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

/**
 * THE NO-LUNCH RULE. An employee whose LAST punch of a two-punch day is
 * before this time (15:00) left before lunch, so no lunch was taken and the
 * break allowance is not credited against their late arrival or early out:
 * every minute between the shift's in-time and the first punch, and between
 * the last punch and the shift's out-time, is short. NRM itself is
 * unchanged - it is the day's normal - and the phased break charge is
 * unchanged; only the credit an uncharged break would otherwise give against
 * lateness and early out is withheld.
 */
const BREAK_CREDIT_CUTOFF_MINUTES = 15 * 60;

/**
 * Bumped whenever a stored calculation would come out differently.
 *
 *   1  Attendance v2 as approved.
 *   2  The effective raw punch stream: manually VOIDED punches are excluded
 *      and a raw punch ten minutes or less after the last kept one is
 *      IGNORED as a duplicate (`utils/attendance_effective_punches.js`).
 *      Historical dates can now come out differently, so a row stored under
 *      version 1 is distinguishable from one the new rule produced; nothing
 *      is recalculated automatically - Recalculate Attendance applies it to a
 *      chosen range.
 *   3  Lateness and early-out grace are forgiven from the shortage, and the
 *      shift's deduction interval rule settles the late/early minutes the
 *      shortage contains (`applyGrace`).
 *   4  The employee break override applies only on a day with four or more
 *      punches; a two-punch day is charged the shift's break.
 *   5  The no-lunch rule: a two-punch day ending before 15:00 gets no break
 *      credit against lateness or early out (`BREAK_CREDIT_CUTOFF_MINUTES`).
 *   6  "Exclude Minimum OT": with the shift flag on, only minutes beyond the
 *      OT minimum are paid (post-shift and pre-shift each have their own).
 *   7  The employee's Extra Break Hours ADD to the day's allowed break, and
 *      therefore reduce NRM by the same minutes - on a COMPLETE punched
 *      sequence of four or more (4, 6, 8 ...) and on no other kind of day.
 *      A configured value that would leave no working minutes at all is
 *      refused rather than applied: the date is a BREAK_EXCEEDS_SHIFT review
 *      instead (see `calculateAttendanceDay`).
 *   8  The employee break override of version 4 now requires the SAME
 *      complete punched sequence: four or more punches AND an even number of
 *      them. It had asked only for four or more, so a five- or seven-punch
 *      day - a day the engine itself reports as MISSING_PUNCH, whose figures
 *      are provisional - was charged the employee's personal break. Such a
 *      day is now calculated on the shift's own break, like every other
 *      incomplete day. Both settings read one shared predicate.
 *   9  THE PAYROLL BASE NRM. Regular time, overtime and shortage are measured
 *      against `base_nrm_minutes` - the PERMANENT shift's NRM for the date -
 *      rather than against the NRM of the shift the date was calculated
 *      under. The two differ only on a date carrying an approved one-day
 *      shift override, where the temporary shift decides every attendance
 *      rule and the permanent one decides the entitlement. `regular_minutes`
 *      and `base_nrm_minutes` are stored on the row, and the two-punch OT
 *      restriction is expressed as the uncharged break it always stood for.
 *      On such a date the shortage is the arithmetic MAX(0, base NRM -
 *      worked): the late and early-going rules still report their flags, but
 *      they do not charge, because they are measuring against hours the
 *      employee was never entitled to.
 *  10  OT AUTHORISED BY AN APPROVED ONE-DAY SHIFT CHANGE. A date whose shift
 *      came from a finally approved SHIFT_CHANGE request needs no separate OT
 *      request for the overtime that shift produces: `shift_authorised_ot_minutes`
 *      is derived from the actual minutes on every calculation, never frozen
 *      at approval, and `excess_ot_minutes` - what falls outside the approved
 *      window - keeps the ordinary request path. `approved_ot_minutes` is the
 *      authorised portion plus whatever a request approved of the excess, so
 *      no minute can be approved twice.
 */
const CALCULATION_VERSION = 10;

/** Every value `status` can take. A calculation is never left without one. */
const CALC_STATUS = Object.freeze({
  FINAL: "FINAL",
  ABSENT: "ABSENT",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  REGULARIZATION_PENDING: "REGULARIZATION_PENDING",
  OT_PENDING: "OT_PENDING",
  NO_SHIFT_FOR_DATE: "NO_SHIFT_FOR_DATE",
  NO_SCHEDULE_ROW: "NO_SCHEDULE_ROW",
  /**
   * The employee is exempt from biometric attendance
   * (`new_employee.attendance_required = 0`).
   *
   * A SETTLED, FINAL verdict, not a review state and not an absence. Some
   * active, paid employees are simply not expected to punch, and for them
   * the absence of a punch is evidence of nothing. The day therefore
   * produces no shortage, no missing-punch reason, no NO_SHIFT and no
   * deduction, and it is reported under its own name rather than being
   * disguised as a normal FINAL day - a reader of the stored row can always
   * see why it carries no minutes.
   */
  ATTENDANCE_NOT_REQUIRED: "ATTENDANCE_NOT_REQUIRED",
});

/** Why a date needs a human. Empty on a clean day. */
const REVIEW_REASON = Object.freeze({
  MISSING_PUNCH: "MISSING_PUNCH",
  NO_SHIFT_FOR_DATE: "NO_SHIFT_FOR_DATE",
  NO_SCHEDULE_ROW: "NO_SCHEDULE_ROW",
  /**
   * The permitted break is as long as the shift, or longer, so the day has
   * no working minutes left to owe.
   *
   * A CONFIGURATION FAULT, reported like the other two: a reason on a
   * REVIEW_REQUIRED day that is NOT final, so its shortage and its OT are
   * held out of payroll exactly as an unsettled day's are. It is raised only
   * where a configured Extra Break Hours would cause it - the Shift Master
   * already refuses a break longer than its own span
   * (`utils/workShift.js`), and a day that reaches NRM 0 without an extra
   * break is whatever it has always been, unchanged.
   *
   * WHY NOT A SILENT CAP. Capping the break would pay the day against an NRM
   * nobody configured, and an NRM of zero is what `utils/attendance_payroll.js`
   * cannot price and `utils/payrun_calculation.js` discards. An Employee
   * Master typo must not be able to manufacture either state, so the day is
   * handed to a human with the cause named.
   */
  BREAK_EXCEEDS_SHIFT: "BREAK_EXCEEDS_SHIFT",
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

  // EXCLUDE MINIMUM (DigiSME's "Exclude Minimum Over Time"): the minimum
  // qualifies the day and is then not paid - only the minutes beyond it are.
  // 39 on a 20-minute minimum pays 19. Takes precedence over the
  // threshold-only / floor reading, which only applies with it off.
  let minutes = snapshot.overtime_minimum_excluded
    ? raw - minimum
    : snapshot.overtime_minimum_threshold_only
      ? raw
      : Math.max(raw, minimum);

  minutes = roundOvertime(
    minutes,
    snapshot.overtime_rounding_method,
    snapshot.overtime_rounding_interval_minutes
  );

  const cap = snapshot.maximum_ot_minutes_per_day;
  if (cap !== null && cap !== undefined) minutes = Math.min(minutes, Math.max(0, Math.trunc(cap)));

  return Math.max(0, minutes);
}

/** The shift's rounding, applied to one OT figure. `NONE` or interval 0 = exact. */
function roundOvertime(minutes, method, intervalMinutes) {
  const interval = Math.max(0, Math.trunc(intervalMinutes || 0));
  const how = String(method || "NONE").toUpperCase();
  if (interval <= 0 || how === "NONE") return minutes;
  if (how === "UP") return Math.ceil(minutes / interval) * interval;
  if (how === "DOWN") return Math.floor(minutes / interval) * interval;
  if (how === "NEAREST") return Math.round(minutes / interval) * interval;
  return minutes;
}

/**
 * PRE-SHIFT OT, under its own four columns.
 *
 * qualify -> round. There is deliberately no floor step and no
 * `..._threshold_only` flag, because Shift Management has no such column for
 * pre-shift OT: `pre_shift_overtime_minimum_minutes` is read as a QUALIFYING
 * threshold only. Reading it as a floor would pay somebody for minutes they
 * did not work before their shift started, which is the one direction an
 * unstated rule must not err in.
 */
function applyPreShiftOvertimeRules(rawMinutes, snapshot) {
  const raw = Math.max(0, Math.trunc(rawMinutes || 0));
  if (!snapshot || !snapshot.pre_shift_overtime_allowed) return 0;
  if (raw === 0) return 0;

  const minimum = Math.max(0, Math.trunc(snapshot.pre_shift_overtime_minimum_minutes || 0));
  if (raw < minimum) return 0;

  // Exclude minimum, the same reading as post-shift: only minutes beyond
  // the minimum are paid.
  const minutes = roundOvertime(
    snapshot.pre_shift_overtime_minimum_excluded ? raw - minimum : raw,
    snapshot.pre_shift_overtime_rounding_method,
    snapshot.pre_shift_overtime_rounding_interval_minutes
  );
  return Math.max(0, minutes);
}

/**
 * The whole OT decision for one day, from the earned surplus and the shift.
 *
 * The order is: SPLIT the surplus into its pre-shift and post-shift parts,
 * apply the configured OFFSETS to it, put each part through its own rules, add
 * them, then apply the per-day CAP to the total.
 *
 * The cap is applied to the TOTAL rather than to each half, because
 * `maximum_ot_minutes_per_day` says per DAY; capping the halves separately
 * would let a shift with both kinds of OT pay twice its own maximum.
 *
 * "POST-SHIFT" HERE MEANS "THE REST OF IT". The pre-shift part is exactly the
 * surplus that sits before the shift's in-time; everything else earned - time
 * after the out-time, and on a four-or-more-punch day the minutes of an unused
 * break - falls under the ordinary `overtime_*` rules. That is deliberate:
 * `overtime_allowed`, its minimum and its rounding are the rules for ordinary
 * overtime, and an unused break is ordinary overtime rather than a third kind
 * with no configuration of its own.
 *
 * Offsets come off the post-shift part first. A late arrival and an early
 * finish are both failures against the shift's own hours, and the minutes the
 * employee chose to stay after it are the ones that answer for them; only when
 * those run out does the offset reach pre-shift time.
 *
 * @returns {object} every intermediate figure, so a payslip query can be
 *   answered from the stored row instead of by re-running this function.
 */
function resolveOvertime({
  raw_ot_minutes = 0,
  pre_shift_minutes = 0,
  late_minutes = 0,
  early_exit_minutes = 0,
  shift = null,
}) {
  const earned = Math.max(0, Math.trunc(raw_ot_minutes || 0));

  // Only surplus that actually sits before the shift can be pre-shift OT.
  let preRaw = Math.min(Math.max(0, Math.trunc(pre_shift_minutes || 0)), earned);
  let postRaw = Math.max(0, earned - preRaw);

  let offset = 0;
  if (shift && shift.late_offset_against_overtime) {
    offset += Math.max(0, Math.trunc(late_minutes || 0));
  }
  if (shift && shift.early_exit_offset_against_overtime) {
    offset += Math.max(0, Math.trunc(early_exit_minutes || 0));
  }
  if (offset > 0) {
    const fromPost = Math.min(postRaw, offset);
    postRaw -= fromPost;
    preRaw = Math.max(0, preRaw - (offset - fromPost));
  }

  // Pre-shift time the shift does not pay for is excluded here, rather than
  // being folded into the post-shift figure where it would be paid anyway.
  const preOt = applyPreShiftOvertimeRules(preRaw, shift);
  const postOt = applyOvertimeRules(postRaw, shift);

  let total = preOt + postOt;
  const cap = shift ? shift.maximum_ot_minutes_per_day : null;
  if (cap !== null && cap !== undefined) total = Math.min(total, Math.max(0, Math.trunc(cap)));

  return {
    pre_shift_eligible_minutes: preRaw,
    post_shift_eligible_minutes: postRaw,
    ot_offset_minutes: offset,
    pre_shift_ot_minutes: preOt,
    post_shift_ot_minutes: postOt,
    candidate_ot_minutes: Math.max(0, total),
  };
}

/* --------------------------------------------------------- the day itself */

/**
 * Settle the part of the shortage that lateness and early out account for,
 * under the Work Shift's own rules.
 *
 * Step 1 - GRACE. With `late_grace_minutes` G and "Do Not Deduct Grace
 * Minutes" (`late_exclude_grace_from_deduction`) X:
 *   - late <= G          -> the whole late is forgiven, whatever X says.
 *   - late  > G and X on -> the first G minutes are forgiven, the rest count.
 *   - late  > G and X off-> nothing is forgiven: the grace was used up and the
 *                           whole late arrival counts, from minute one.
 * Early out has a grace and no switch, so it is forgiven only when it fits
 * inside the grace entirely.
 *
 * Step 2 - ATTRIBUTION. Only minutes the shortage actually contains can be
 * settled here. A break gap that ran long is not a late arrival, and a late
 * arrival that was worked off at the end of the day (the shortage is 0) is
 * charged nothing: v2 never deducts a minute that was also worked. So the
 * late minutes that count are capped at the shortage, and the early-out
 * minutes at what is left of it after the late.
 *
 * Step 3 - THE DEDUCTION RULE. With `late_deduction_interval_minutes` I and
 * `late_deduct_minutes` D both set, every started interval of the counted
 * late minutes is charged D minutes: charged = ceil(counted / I) * D. With
 * either at 0 the rule is not configured and the counted minutes are charged
 * one for one, which is exactly what the shortage already did. Early out has
 * its own I and D. The charge can exceed the minutes it stands for - that is
 * what the rule is for - but the day's total shortage is capped at NRM, so a
 * day can never owe more than the whole day.
 */
function applyGrace({
  shortage_minutes = 0,
  late_minutes = 0,
  early_exit_minutes = 0,
  nrm_minutes = null,
  break_credit_withheld = false,
  shift,
} = {}) {
  const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));
  const shortage = int(shortage_minutes);
  const late = int(late_minutes);
  const early = int(early_exit_minutes);
  const cfg = shift || {};
  const lateGrace = int(cfg.late_grace_minutes);
  const earlyGrace = int(cfg.early_exit_grace_minutes);
  const excludeGrace = Boolean(cfg.late_exclude_grace_from_deduction);

  // 1. grace
  let lateForgiven = 0;
  if (late > 0 && lateGrace > 0) {
    if (late <= lateGrace) lateForgiven = late;
    else if (excludeGrace) lateForgiven = lateGrace;
  }
  const earlyForgiven = early > 0 && earlyGrace > 0 && early <= earlyGrace ? early : 0;

  // 2. attribution, against the shortage the day actually has. The raw late
  // and early-out portions are carved out of the shortage FIRST, then the
  // grace comes off each portion. Carving after forgiving would let the
  // early-out portion grow into the minutes the grace had just forgiven,
  // and the forgiveness would silently vanish from the total.
  // With the break credit withheld (the no-lunch rule) the late and early
  // portions are NOT capped at the shortage: an uncharged break is not
  // allowed to absorb them.
  const lateRaw = break_credit_withheld ? late : Math.min(late, shortage);
  const earlyRaw = break_credit_withheld ? early : Math.min(early, shortage - lateRaw);
  const otherShortage = Math.max(0, shortage - lateRaw - earlyRaw);
  const lateCounted = Math.max(0, lateRaw - lateForgiven);
  const earlyCounted = Math.max(0, earlyRaw - earlyForgiven);

  // 3. the interval rule
  const charge = (counted, interval, deduct) =>
    counted > 0 && interval > 0 && deduct > 0 ? Math.ceil(counted / interval) * deduct : counted;
  const lateCharged = charge(lateCounted, int(cfg.late_deduction_interval_minutes), int(cfg.late_deduct_minutes));
  const earlyCharged = charge(
    earlyCounted,
    int(cfg.early_exit_deduction_interval_minutes),
    int(cfg.early_exit_deduct_minutes)
  );

  let settled = otherShortage + lateCharged + earlyCharged;
  if (nrm_minutes !== null && nrm_minutes !== undefined) settled = Math.min(settled, int(nrm_minutes));

  return {
    shortage_minutes: settled,
    grace_forgiven_minutes: Math.min(lateRaw, lateForgiven) + Math.min(earlyRaw, earlyForgiven),
    late_forgiven_minutes: lateForgiven,
    early_forgiven_minutes: earlyForgiven,
    late_charged_minutes: lateCharged,
    early_exit_charged_minutes: earlyCharged,
  };
}

/**
 * Calculate one employee's one attendance date.
 *
 * @param {object} input
 * @param {number} input.employee_id
 * @param {string} input.attendance_date          `YYYY-MM-DD`
 * @param {Array}  input.punches                  RAW punches that COUNT: the
 *        effective raw stream after manual voids and the ten-minute duplicate
 *        rule (`utils/attendance_effective_punches.js`) have been applied
 * @param {Array}  [input.excluded_punches]       the raw punches of the date
 *        that do NOT count - VOIDED or IGNORED_DUPLICATE, each with its
 *        `effective_status` and reason. Carried through for the audit views;
 *        they take no part in any number here
 * @param {Array}  [input.regularized_punches]    APPROVED manual punches only
 * @param {object|null} input.shift                a `buildShiftSnapshot` result
 * @param {string} [input.shift_status]            RESOLUTION_STATUS from A0
 * @param {number|null} [input.break_override_minutes] the employee's special
 *        break, which REPLACES the shift break and therefore changes NRM
 * @param {number|null} [input.extra_break_minutes] the employee's Extra Break
 *        Hours, in whole minutes, which are ADDED to whatever allowance the
 *        line above resolved and therefore reduce NRM by the same amount
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
    excluded_punches = [],
    regularized_punches = [],
    shift = null,
    shift_status = null,
    break_override_minutes = null,
    extra_break_minutes = null,
    approved_ot_minutes = null,
    regularization_pending = false,
    attendance_required = true,
    base_nrm_minutes = null,
    base_shift = null,
    // The date's shift override is backed by a FINALLY APPROVED one-day
    // SHIFT_CHANGE request. See `resolveShiftAuthorisedOvertime` below.
    shift_authorised = false,
    shift_change_request_id = null,
  } = input;

  const rawPunches = orderPunches(punches, attendance_date);
  // Every effective punch is marked USED so a reader of the stored JSON can
  // tell it apart from the excluded ones without consulting a second list.
  const effectivePunches = orderPunches(
    [...(punches || []), ...(regularized_punches || [])],
    attendance_date
  ).map((p) => ({ ...p, effective_status: "USED" }));
  // The raw punches of the date that were voided or ignored: chronological,
  // never counted, never paired. `raw_punch_ids` lists ALL raw evidence for
  // the date, counted or not, so the stored row still names every raw punch
  // the engine looked at.
  const excludedById = new Map((excluded_punches || []).map((e) => [String(e.punch_id), e]));
  const excludedPunches = orderPunches(excluded_punches || [], attendance_date).map((p) => ({
    ...(excludedById.get(String(p.punch_id)) || {}),
    ...p,
  }));

  const base = {
    calculation_version: CALCULATION_VERSION,
    employee_id,
    attendance_date,
    work_shift_id: shift ? shift.work_shift_id : null,
    work_shift_weekly_schedule_id: shift ? shift.work_shift_weekly_schedule_id : null,
    shift_snapshot: shift,
    shift_snapshot_hash: shift ? shift.snapshot_hash : null,
    raw_punch_ids: [...rawPunches, ...excludedPunches]
      .sort((a, b) => a.minute - b.minute || Number(a.punch_id) - Number(b.punch_id))
      .map((p) => p.punch_id),
    raw_punches: rawPunches,
    excluded_punches: excludedPunches,
    effective_punches: effectivePunches,
    punch_count: effectivePunches.length,
    attendance_day_count: 0,
    nrm_minutes: 0,
    // THE PAYROLL BASE. On an ordinary day these are the day's own NRM and
    // its own shift. On a day carrying an APPROVED ONE-DAY SHIFT OVERRIDE
    // they are the PERMANENT shift's - see `resolvePayrollNrm` below for why
    // the two have to be separate concepts on the same row.
    base_nrm_minutes: 0,
    base_work_shift_id: base_shift ? Number(base_shift.work_shift_id) || null : null,
    // Regular = MIN(worked, base NRM). Stored rather than re-derived so a
    // payslip query never has to know the rule.
    regular_minutes: 0,
    /*
     * SHIFT-AUTHORISED OT. The portion of this day's overtime that an
     * approved one-day shift change already authorises, and which therefore
     * needs no separate OT request; `excess_ot_minutes` is what is left for
     * the ordinary OT request path. On every other date the first is 0 and
     * the second is the whole candidate, which is what every existing caller
     * already assumed.
     */
    shift_authorised_ot_minutes: 0,
    excess_ot_minutes: 0,
    approved_ot_source: null,
    shift_change_request_id:
      shift_change_request_id === undefined ? null : shift_change_request_id,
    span_minutes: 0,
    break_allowance_minutes: 0,
    break_allowance_source: "SHIFT",
    // PROVENANCE: which employee-specific settings this date actually
    // applied, as opposed to which were configured. The total allowance
    // above cannot be split back into the two once both are in play, and
    // neither setting has any change history, so a date that does not record
    // them can never explain its own NRM again.
    //
    //   break_override_minutes_applied  the override that REPLACED the shift
    //                                   break, or null if none was applied.
    //                                   An applied 0 is a real setting and is
    //                                   not the same as null.
    //   extra_break_minutes_applied     the Extra Break Hours ADDED, in
    //                                   minutes. 0 on every day that did not
    //                                   credit them.
    break_override_minutes_applied: null,
    extra_break_minutes_applied: 0,
    actual_gap_minutes: null,
    break_charged_minutes: 0,
    worked_minutes: 0,
    shortage_minutes: 0,
    grace_forgiven_minutes: 0,
    break_credit_withheld: false,
    late_charged_minutes: 0,
    early_exit_charged_minutes: 0,
    late_minutes: null,
    early_exit_minutes: null,
    pre_shift_minutes: 0,
    post_shift_minutes: 0,
    candidate_ot_minutes: 0,
    raw_ot_minutes: 0,
    pre_shift_ot_minutes: 0,
    post_shift_ot_minutes: 0,
    ot_offset_minutes: 0,
    approved_ot_minutes: 0,
    ot_rate: shift ? shift.ot_rate : null,
    is_final: false,
    status: CALC_STATUS.REVIEW_REQUIRED,
    review_reasons: [],
    notes: [],
  };

  // EXEMPT FROM BIOMETRIC ATTENDANCE, and therefore settled before any
  // other verdict - including the no-shift one below.
  //
  // The order matters. An exempt employee frequently has no shift assigned,
  // because a shift is an attendance artefact and they have no attendance to
  // roster; reporting NO_SHIFT_FOR_DATE for them would be reporting a
  // configuration fault that is not one, and it is exactly what put such
  // employees in the review queue and the attention counts. So the exemption
  // answers first. Whatever punches exist are still carried on the row - an
  // exempt employee is not forbidden to punch - they simply decide nothing.
  if (attendance_required === false) {
    return {
      ...base,
      status: CALC_STATUS.ATTENDANCE_NOT_REQUIRED,
      is_final: true,
      review_reasons: [],
      notes: ["Biometric attendance is not required for this employee"],
    };
  }

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

  // ============ THE ONE PRECONDITION BOTH EMPLOYEE BREAK SETTINGS SHARE ====
  //
  // A COMPLETE PUNCHED SEQUENCE: four or more punches AND an even number of
  // them - 4, 6, 8 and so on.
  //
  // Every punched break is an OUT followed by an IN, so a day whose breaks
  // are on record has an even punch count. Five or seven punches is a day
  // with one punch MISSING: the engine returns MISSING_PUNCH for it below,
  // its figures are provisional until somebody supplies the missing punch,
  // and a provisional day must not also carry an employee-specific permitted
  // break that the evidence does not support. A two-punch day has no OUT ->
  // IN evidence of any break at all and is charged the SHIFT's allowance
  // under the unchanged phased rule; an absent day is calculated on the
  // shift's own figure too.
  //
  // ONE PREDICATE, BOTH SETTINGS. The override and the Extra Break Hours once
  // asked this question in two slightly different ways - `>= 4` and
  // `>= 4 && even` - which is exactly how a five-punch day came to be charged
  // a personal break while being told a punch was missing. They ask it here,
  // once, and cannot drift apart again.
  const completeSequence = effectivePunches.length >= 4 && effectivePunches.length % 2 === 0;

  // The employee's special break override REPLACES the shift break (it does
  // not add to it), and because NRM is span - break, changing it changes the
  // number of minutes the employee owes for the day.
  //
  // A CONFIGURED ZERO IS A REAL OVERRIDE - "charge this employee no break at
  // all" - and is not the same as no override. `overrideConfigured` therefore
  // tests for a finite number and never for truthiness.
  const overrideConfigured =
    break_override_minutes !== null &&
    break_override_minutes !== undefined &&
    Number.isFinite(Number(break_override_minutes));
  const overrideGiven = overrideConfigured && completeSequence;
  const baseAllowedBreak = Math.max(
    0,
    Math.trunc(overrideGiven ? Number(break_override_minutes) : shift.break_minutes || 0)
  );

  // THE EMPLOYEE'S EXTRA BREAK HOURS. Unlike the override above it ADDS to
  // whatever allowance was just resolved - the shift's break, or the
  // override that replaced it:
  //
  //     employeeAllowedBreak = resolvedAllowedBreak + extraBreak
  //
  // and because NRM is span - allowance, the extra minutes come off NRM for
  // this employee on this date. The Shift Master is never touched: this is an
  // employee/date adjustment and the shift's own break stays what it is.
  //
  // IT OBEYS THE SAME `completeSequence` RULE as the override above, from the
  // same predicate, for the same reason: an allowance is credit against a
  // break the punches can be seen to contain.
  const extraConfigured =
    extra_break_minutes !== null &&
    extra_break_minutes !== undefined &&
    Number.isFinite(Number(extra_break_minutes)) &&
    Math.trunc(Number(extra_break_minutes)) > 0;
  const shiftSpan = Math.max(0, Math.trunc(shift.shift_span_minutes || 0));
  const extraWanted = extraConfigured ? Math.trunc(Number(extra_break_minutes)) : 0;

  // THE SAFETY INVARIANT: resolvedAllowedBreak + extraBreak < shiftSpan.
  //
  // A permitted break as long as the shift leaves NRM at zero, which payroll
  // treats as unrateable and the payrun discards - so an Employee Master typo
  // could otherwise turn a real working day into an unpayable one, silently.
  // It is checked HERE, against the day's own resolved span, rather than
  // trusted to the Employee Master's input validation alone: the shift can be
  // shortened long after the hours were recorded, and the value that was
  // sensible on Monday can be impossible on Tuesday.
  //
  // A span of zero is left alone deliberately. There is no working duration
  // to exceed, the day already produces nothing, and raising a configuration
  // fault there would change a day the extra break was never going to touch.
  const extraBreakExceedsShift =
    completeSequence && extraWanted > 0 && shiftSpan > 0 && baseAllowedBreak + extraWanted >= shiftSpan;

  const extraGiven = completeSequence && extraWanted > 0 && !extraBreakExceedsShift && shiftSpan > 0;
  const extraBreak = extraGiven ? extraWanted : 0;

  const allowedBreak = Math.max(0, baseAllowedBreak + extraBreak);
  const nrm = Math.max(0, shiftSpan - allowedBreak);

  /*
   * THE PAYROLL BASE NRM, AND WHY IT IS NOT ALWAYS THE DAY'S OWN NRM.
   *
   * `nrm` above is the NRM of the shift this date was CALCULATED under - the
   * one that decides the expected in and out, the lunch and break rules, the
   * late and early-going flags and how many punches the day should contain.
   * On an ordinary date that is also the employee's entitlement, so the two
   * are the same number and nothing below changes.
   *
   * On a date carrying an APPROVED ONE-DAY SHIFT OVERRIDE they are NOT the
   * same. An employee whose permanent shift is 6pm-10pm (4h) and who is
   * approved to work 10am-10pm for one Saturday is still ENTITLED to 4h: the
   * longer day is overtime, not a larger regular day, and the salary master
   * is untouched. Measuring regular time against the temporary shift would
   * pay 10h of regular and no overtime; measuring SHORTAGE against it would
   * invent 7h of shortage for somebody who worked 3h of a 4h entitlement.
   *
   * So the three PAY figures - regular, overtime and shortage - are measured
   * against `payrollNrm`, the base/permanent shift's NRM for the date, while
   * every ATTENDANCE rule above and below goes on reading the resolved
   * shift's own snapshot. `base_nrm_minutes` is supplied by the caller
   * (`usecase/attendance_calculation.js`, which resolves the permanent
   * assignment history for the date alongside the override); when it is not
   * supplied the day's own NRM is the base, which is every ordinary date.
   */
  /*
   * The base NRM is computed HERE, from the base shift's own snapshot, rather
   * than handed in as a number - so it goes through exactly the same break
   * rules the day's own NRM went through (the employee's break override
   * REPLACES the shift break, their Extra Break Hours are ADDED to it, and
   * both need a complete punched sequence). A caller computing it separately
   * would be a second implementation of that rule, and the first one to drift.
   *
   * `base_nrm_minutes` remains as an explicit escape hatch for tests and for
   * a caller that has the figure already; `base_shift` wins when both arrive.
   */
  let payrollNrm = nrm;
  // True only on a date whose shift is NOT the employee's permanent one.
  let payrollBaseDiffers = false;
  if (base_shift && Number(base_shift.work_shift_id) !== Number(shift.work_shift_id)) {
    payrollBaseDiffers = true;
    const baseSpan = Math.max(0, Math.trunc(base_shift.shift_span_minutes || 0));
    const baseBreak = Math.max(
      0,
      Math.trunc(overrideGiven ? Number(break_override_minutes) : base_shift.break_minutes || 0)
    );
    const baseExtra = extraGiven && baseBreak + extraWanted < baseSpan ? extraWanted : 0;
    payrollNrm = Math.max(0, baseSpan - (baseBreak + baseExtra));
  } else if (
    base_nrm_minutes !== null &&
    base_nrm_minutes !== undefined &&
    Number.isFinite(Number(base_nrm_minutes))
  ) {
    payrollNrm = Math.max(0, Math.trunc(Number(base_nrm_minutes)));
  }
  base.base_nrm_minutes = payrollNrm;

  base.break_allowance_minutes = allowedBreak;
  // EMPLOYEE_OVERRIDE means "this allowance is the employee's, not the
  // shift's" - which is exactly what an added Extra Break makes it, so the
  // payrun's NRM provenance keeps its two words and gains no third.
  base.break_allowance_source = overrideGiven || extraGiven ? "EMPLOYEE_OVERRIDE" : "SHIFT";
  base.break_override_minutes_applied = overrideGiven ? baseAllowedBreak : null;
  base.extra_break_minutes_applied = extraBreak;
  base.nrm_minutes = nrm;
  if (overrideConfigured && !overrideGiven && effectivePunches.length > 0) {
    base.notes.push(
      "Employee break override not applied: it needs a complete punched sequence of four or more, so the shift's break is used"
    );
  }
  if (extraWanted > 0 && !extraGiven && !extraBreakExceedsShift && effectivePunches.length > 0) {
    base.notes.push(
      "Employee extra break hours not applied: they need a complete punched sequence of four or more, so the day's own break allowance is used"
    );
  }

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
  // The two OFFSET switches below can subtract them from OVERTIME, which is a
  // different thing from charging for them and is the only use v2 makes of
  // either figure.
  const shiftIn = timeToMinutes(shift.in_time);
  if (shiftIn !== null) {
    base.late_minutes = Math.max(0, first.minute - shiftIn);
    base.early_exit_minutes = Math.max(0, shiftIn + shiftSpan - last.minute);
    // Time genuinely outside the shift's own hours, before it and after it.
    base.pre_shift_minutes = Math.max(0, shiftIn - first.minute);
    base.post_shift_minutes = Math.max(0, last.minute - (shiftIn + shiftSpan));
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

  // THE INVARIANT, ENFORCED BEFORE ANY MINUTE IS SETTLED.
  //
  // Reached only on a complete sequence of four or more, because that is the
  // only day the extra break is credited on at all. Nothing is capped and
  // nothing is paid: the break allowance and the NRM on the row are the
  // day's own UNEXTENDED figures (the extra break was not applied above), the
  // day is NOT final, and it carries the reason that says why. A day that is
  // not final has its shortage and its OT held out of payroll by
  // `utils/attendance_payroll.js`, so no OT can be claimed from a zero NRM
  // and the date cannot settle as a payable day while the configuration
  // stands. Correcting the hours - or the shift - and recalculating is what
  // clears it.
  if (extraBreakExceedsShift) {
    return {
      ...base,
      status: CALC_STATUS.REVIEW_REQUIRED,
      review_reasons: [REVIEW_REASON.BREAK_EXCEEDS_SHIFT],
      is_final: false,
      notes: [
        ...base.notes,
        `Extra Break Hours not applied: the permitted break would be ${baseAllowedBreak + extraWanted} minute(s) of a ${shiftSpan} minute shift, leaving no working minutes. The date is held for review until the employee's Extra Break Hours or the shift is corrected.`,
      ],
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
    // THE UNCHARGED BREAK, not a fixed span comparison.
    //
    // This used to read `span - shiftSpan`, which is the same number whenever
    // the pay base IS the day's own shift: surplus = span - breakCharged -
    // (shiftSpan - allowedBreak), so subtracting the break the day was
    // credited but cannot prove it took - `allowedBreak - breakCharged` -
    // leaves exactly `span - shiftSpan`. Written this way it stays correct on
    // a one-day override, where the surplus is measured against the BASE
    // shift and the old form would have suppressed genuine overtime for the
    // hours between the base shift's span and the longer temporary one.
    otBasis = Math.max(
      0,
      Math.max(0, Math.max(0, span - breakCharged) - payrollNrm) -
        Math.max(0, allowedBreak - breakCharged)
    );
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
  // Against the PAYROLL BASE, never against a temporary shift's own NRM.
  const rawShortage = Math.max(0, payrollNrm - worked);
  const surplus = Math.max(0, worked - payrollNrm);

  // The no-lunch rule: a two-punch day whose last punch is before the cutoff.
  const breakCreditWithheld =
    effectivePunches.length === 2 && allowedBreak > 0 && last.minute < BREAK_CREDIT_CUTOFF_MINUTES;
  base.break_credit_withheld = breakCreditWithheld;
  if (breakCreditWithheld) {
    base.notes.push("Left before 15:00: no lunch taken, so the break is not credited against lateness or early out");
  }

  const grace = applyGrace({
    shortage_minutes: rawShortage,
    break_credit_withheld: breakCreditWithheld,
    late_minutes: base.late_minutes || 0,
    early_exit_minutes: base.early_exit_minutes || 0,
    nrm_minutes: payrollNrm,
    shift,
  });
  /*
   * ON AN OVERRIDE DAY THE SHORTAGE IS ARITHMETIC, NOT A DEDUCTION RULE.
   *
   *     shortage = MAX(0, base NRM - worked)
   *
   * and nothing else. The late and early-going rules above still RUN - the
   * flags are the temporary shift's and are reported as such - but they may
   * not charge against the day, because on an override day they are measuring
   * against hours the employee was never entitled to in the first place.
   * Somebody permanently on 18:00-22:00, approved to cover 10:00-22:00 and
   * leaving at 13:00, is nine hours "early" against the temporary shift; they
   * are one hour short of their four-hour entitlement, and the interval rule
   * would otherwise turn that into a whole missing day.
   *
   * On every ordinary date the two shifts are the same shift, this is false,
   * and the deduction rules decide the shortage exactly as they always have.
   */
  const shortage = payrollBaseDiffers ? rawShortage : grace.shortage_minutes;

  base.actual_gap_minutes = actualGaps;
  base.break_charged_minutes = breakCharged;
  base.worked_minutes = worked;
  base.regular_minutes = Math.min(worked, payrollNrm);
  base.shortage_minutes = shortage;
  base.grace_forgiven_minutes = payrollBaseDiffers ? 0 : grace.grace_forgiven_minutes;
  base.late_charged_minutes = payrollBaseDiffers ? 0 : grace.late_charged_minutes;
  base.early_exit_charged_minutes = payrollBaseDiffers ? 0 : grace.early_exit_charged_minutes;
  if (payrollBaseDiffers && (grace.late_charged_minutes > 0 || grace.early_exit_charged_minutes > 0)) {
    base.notes.push(
      "One-day shift: lateness and early going are measured against the day's shift and reported, but the shortage is the base shift's entitlement less the minutes worked"
    );
  }
  if (!payrollBaseDiffers && shortage !== rawShortage - grace.grace_forgiven_minutes && !breakCreditWithheld) {
    base.notes.push(
      `Deduction rule: late charged ${grace.late_charged_minutes} minute(s), early out charged ${grace.early_exit_charged_minutes} minute(s) under the shift's interval rule`
    );
  }
  if (grace.grace_forgiven_minutes > 0) {
    base.notes.push(
      `Grace: ${grace.grace_forgiven_minutes} minute(s) forgiven from the shortage (late ${grace.late_forgiven_minutes}, early out ${grace.early_forgiven_minutes})`
    );
  }

  const rawOt = otBasis === null ? surplus : Math.min(surplus, otBasis);
  base.raw_ot_minutes = rawOt;

  // Every Shift Management OT rule, in one place: the pre/post split, the two
  // offsets, each side's own minimum and rounding, then the per-day cap.
  const overtime = resolveOvertime({
    raw_ot_minutes: rawOt,
    pre_shift_minutes: base.pre_shift_minutes,
    late_minutes: base.late_minutes || 0,
    early_exit_minutes: base.early_exit_minutes || 0,
    shift,
  });
  base.pre_shift_ot_minutes = overtime.pre_shift_ot_minutes;
  base.post_shift_ot_minutes = overtime.post_shift_ot_minutes;
  base.ot_offset_minutes = overtime.ot_offset_minutes;
  base.candidate_ot_minutes = overtime.candidate_ot_minutes;

  /*
   * ============ OT AUTHORISED BY AN APPROVED ONE-DAY SHIFT CHANGE =========
   *
   * When this date's shift came from a FINALLY APPROVED SHIFT_CHANGE
   * request, that approval is itself the authorisation for the overtime the
   * longer shift produces: the employee is not asked to file a second
   * request for the very hours somebody already agreed they should work.
   *
   * IT IS DERIVED, EVERY TIME, FROM THE ACTUAL MINUTES. Nothing is frozen at
   * approval - a request approved before the day is worked authorises 0 on
   * the day it is approved and the right figure once the punches arrive,
   * because this runs again on every calculation. A later correction that
   * raises or lowers the worked minutes moves it in the same way.
   *
   * THE WINDOW MATTERS. What was approved is a SHIFT - 10:00 to 22:00, say -
   * not unlimited overtime on that date. So the authorised portion is the OT
   * earned INSIDE that window, and the engine already measures what falls
   * outside it:
   *
   *     pre_shift_minutes   worked before the approved in-time
   *     post_shift_minutes  worked after the approved out-time
   *
   * and prices each side separately (`pre_shift_ot_minutes`,
   * `post_shift_ot_minutes`). So:
   *
   *     excess    = pre_shift_ot_minutes
   *               + MIN(post_shift_minutes, post_shift_ot_minutes)
   *     authorised = MAX(0, candidate_ot_minutes - excess)
   *
   * The post term is bounded by BOTH the raw minutes beyond the out-time and
   * the OT actually priced in that bucket, because `post_shift_ot_minutes`
   * also carries in-window earnings (an unused break), which the shift
   * change DID authorise. Bounding it this way can only ever move minutes
   * from the automatic side to the requestable one, never the reverse.
   *
   * The excess keeps the ordinary OT path: the employee requests it, and an
   * approver decides it, exactly as on any other date.
   */
  if (shift_authorised) {
    const preExcess = Math.max(0, Math.trunc(base.pre_shift_ot_minutes || 0));
    const postExcess = Math.min(
      Math.max(0, Math.trunc(base.post_shift_minutes || 0)),
      Math.max(0, Math.trunc(base.post_shift_ot_minutes || 0))
    );
    const excess = Math.min(base.candidate_ot_minutes, preExcess + postExcess);
    base.shift_authorised_ot_minutes = Math.max(0, base.candidate_ot_minutes - excess);
    base.excess_ot_minutes = excess;
    base.approved_ot_source = base.shift_authorised_ot_minutes > 0 ? "SHIFT_CHANGE" : null;
    if (excess > 0) {
      base.notes.push(
        `Approved shift change authorises ${base.shift_authorised_ot_minutes} OT minute(s); ${excess} minute(s) fall outside the approved shift and remain claimable`
      );
    }
  } else {
    base.shift_authorised_ot_minutes = 0;
    base.excess_ot_minutes = base.candidate_ot_minutes;
  }

  /*
   * APPROVED OT: the shift-authorised portion, plus whatever a separate OT
   * REQUEST approved of the excess - and the request can never reach the
   * authorised portion, which is what stops the same minute being paid
   * twice through two different approvals.
   */
  const approved = Math.max(0, Math.trunc(Number(approved_ot_minutes) || 0));
  // Approved OT can never exceed what was actually earned: an approval is a
  // decision about the candidate, not a licence to invent minutes.
  const approvedFromRequest = Math.min(approved, base.excess_ot_minutes);
  base.approved_ot_minutes = Math.min(
    base.shift_authorised_ot_minutes + approvedFromRequest,
    base.candidate_ot_minutes
  );

  if (regularization_pending) {
    base.status = CALC_STATUS.REGULARIZATION_PENDING;
    base.is_final = false;
  } else {
    // ATTENDANCE STATE AND OT CLAIM STATE ARE SEPARATE. A complete, valid day
    // is FINAL whether or not its candidate overtime has been requested,
    // approved or rejected: the day and its shortage go to payroll either
    // way, and only finally approved OT (`approved_ot_minutes`, supplied by
    // the caller from the settled OT request) is paid. The OT claim itself -
    // available / requested / approved / rejected / closed at payroll lock -
    // is derived beside the day by the calculation usecase, not encoded in
    // this status. `CALC_STATUS.OT_PENDING` remains declared because stored
    // rows and the database enum carry it, but the engine no longer produces
    // it.
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
  BREAK_CREDIT_CUTOFF_MINUTES,
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
  applyPreShiftOvertimeRules,
  roundOvertime,
  resolveOvertime,
  calculateAttendanceDay,
  applyGrace,
};
