/**
 * MAY THIS EMPLOYEE RAISE A ONE-DAY SHIFT CHANGE FOR THIS DATE?
 *
 * ============================================ WHY THIS FILE EXISTS AT ALL ===
 *
 * There are now TWO callers of that question and there must be exactly ONE
 * answer:
 *
 *   the employee   `usecase/attendance_regularization.js#raiseShiftChangeRequest`
 *                  - the Telegram Mini App and the web form both land here,
 *                    and it is what actually creates or refuses a request.
 *   HR             `usecase/attendance_shift_change_report.js` - the Shift
 *                  Change Eligibility report, which must print "Can Raise
 *                  Shift Change? = Yes" for exactly the employees and dates
 *                  the first one would accept, and No with the reason the
 *                  first one would have given.
 *
 * A report that re-derived the rule would be a second definition, and the
 * first thing it would do is tell HR to chase somebody the backend then
 * refuses - or, worse, stay silent about somebody who could have regularised
 * a long day. So `decide` below IS the rule, it lives here, and both callers
 * call it. Neither has a branch of its own.
 *
 * ===================================================== PURE, ON PURPOSE =====
 *
 * No database, no clock, no Express. The caller gathers the five facts the
 * rule turns on and hands them over; this file is arithmetic and a decision
 * table over them. That split is what lets the employee path gather them with
 * per-request reads and the report gather them in batch, over thousands of
 * employee/date pairs, WITHOUT the two paths disagreeing: the reads differ,
 * the rule cannot.
 *
 * ================================== THE RULE, AND WHAT IT IS NOT ============
 *
 * A shift change exists to regularise a LONGER day than the roster, and never
 * to shorten one. Because regular time is paid against the BASE NRM whatever
 * shift a day is calculated under (`utils/attendance_engine.js`), a SHORTER
 * requested shift would not reduce what somebody is owed by a minute - it
 * would only move the expected in and out, quietly forgiving a late arrival
 * and an early finish while the entitlement stayed where it was. Reducing
 * hours is a roster decision and belongs to Edit Shift Assignment, which is
 * dated, audited and needs a management permission.
 *
 * SO ELIGIBILITY DOES NOT LOOK AT PUNCHES, AND MUST NOT START. Whether
 * somebody ACTUALLY worked longer than their assigned shift is a separate,
 * useful question - the report answers it in its own column, "Worked Longer
 * Than Assigned Shift?", from the attendance engine's own worked minutes -
 * but it is not this rule and it never gates a request. A day worked long
 * with no longer shift on the master is still not raisable, and the report
 * says so rather than inventing a permission the backend would refuse.
 */

/** How far back a shift change may be asked for. A month of slack, not a decade. */
const MAX_BACKDATE_DAYS = 45;

/** How far ahead a one-day shift may be asked for. A roster, not a plan. */
const MAX_FORWARD_DAYS = 60;

/**
 * WHY a date is or is not raisable. A code, so the report can filter and the
 * employee path can choose the right error SHAPE, plus a sentence a person
 * reads. Never a bare boolean - "No" without a reason is what sends HR to ask
 * the same question again by email.
 */
const SHIFT_CHANGE_REASON = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  TOO_OLD: "TOO_OLD",
  TOO_FAR_AHEAD: "TOO_FAR_AHEAD",
  PAYROLL_LOCKED: "PAYROLL_LOCKED",
  ALREADY_PENDING: "ALREADY_PENDING",
  ALREADY_APPROVED: "ALREADY_APPROVED",
  NO_BASE_SHIFT: "NO_BASE_SHIFT",
  NO_LONGER_SHIFT: "NO_LONGER_SHIFT",
});

/**
 * The sentences. ONE copy, because the employee is shown these as the reason
 * their request was refused and HR is shown the same words in the report's
 * "Eligibility Reason" column - and two wordings of one rule read as two
 * rules.
 */
const REASON_TEXT = Object.freeze({
  [SHIFT_CHANGE_REASON.ELIGIBLE]: "A longer shift is available for this date",
  [SHIFT_CHANGE_REASON.TOO_OLD]: `A shift change can be requested for the last ${MAX_BACKDATE_DAYS} days only`,
  [SHIFT_CHANGE_REASON.TOO_FAR_AHEAD]: `A shift change can be requested up to ${MAX_FORWARD_DAYS} days ahead only`,
  [SHIFT_CHANGE_REASON.NO_LONGER_SHIFT]:
    "Temporary shift requests are only allowed for shifts with longer working hours than your normal shift.",
});

/** `YYYY-MM-DD` plus `n` days, by UTC arithmetic on the parts. No zone involved. */
function addDays(dateOnly, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * A shift's NRM for a date, FROM ITS SNAPSHOT ALONE: the span less the
 * shift's own break.
 *
 * The employee's break override and Extra Break Hours are deliberately NOT
 * applied, exactly as `usecase/attendance_calculation.js#shiftForDate` does
 * not apply them: they need a punched sequence that does not exist on a date
 * being requested in advance, and this figure exists to COMPARE two shifts
 * with each other, not to pay anybody.
 */
function nrmOfSnapshot(snapshot) {
  if (!snapshot) return null;
  return Math.max(0, (snapshot.shift_span_minutes || 0) - (snapshot.break_minutes || 0));
}

/**
 * Is there a shift this employee could ASK FOR on this date?
 *
 * The same test `shiftChangeOptions` applies per candidate shift, expressed
 * once: a candidate counts when it RUNS that weekday and its NRM for the date
 * is strictly greater than the base NRM. Strictly - an equal-length shift
 * changes nothing worth approving and production refuses it.
 */
function hasLongerShiftOption({ base_nrm_minutes, candidates = [] }) {
  const base = Number(base_nrm_minutes);
  if (!Number.isFinite(base)) return false;
  return candidates.some(
    (c) =>
      c &&
      c.is_working_day !== false &&
      c.nrm_minutes !== null &&
      c.nrm_minutes !== undefined &&
      Number(c.nrm_minutes) > base
  );
}

/** The months a payroll-lock refusal names, as `MM/YYYY`, de-duplicated. */
function lockedMonthsLabel(locked = []) {
  return locked
    .map((l) => `${String(l.month).padStart(2, "0")}/${l.year}`)
    .filter((m, i, all) => all.indexOf(m) === i)
    .join(", ");
}

/**
 * ======================== THE DECISION. THE ONLY ONE. ======================
 *
 * The order of these tests is the ORDER PRODUCTION APPLIES THEM IN, and it is
 * load-bearing rather than cosmetic: an employee whose date is both outside
 * the window and already approved must be told the same thing by the report
 * as by the form, and the only way to guarantee that is for there to be one
 * sequence.
 *
 * @param {object} input
 * @param {string} input.attendance_date  `YYYY-MM-DD`
 * @param {string} input.today            the IST BUSINESS date, never a UTC one
 * @param {Array}  input.payroll_locked   the locked periods covering this
 *                                        employee/date, `[]` when none
 * @param {object|null} input.existing_request  the employee's non-CANCELLED
 *                                        SHIFT_CHANGE request for this date
 * @param {number|null|undefined} input.base_work_shift_id  the PERMANENT
 *                                        shift resolved for the date; null
 *                                        when unassigned, undefined when the
 *                                        caller has not resolved it yet
 * @param {boolean} input.has_longer_option
 * @returns {{can_raise: boolean, reason_code: string, reason: string,
 *            payroll_locked: Array}}
 */
function decide({
  attendance_date,
  today,
  payroll_locked = [],
  existing_request = null,
  base_work_shift_id = null,
  has_longer_option = false,
}) {
  const blocked = decidePreconditions({
    attendance_date,
    today,
    payroll_locked,
    existing_request,
    // `decide` is the COMPLETE form - every fact is in - so an absent shift is
    // an unassigned one here, never an unread one.
    base_work_shift_id: base_work_shift_id === undefined ? null : base_work_shift_id,
  });
  if (blocked) return blocked;
  if (!has_longer_option) {
    return {
      can_raise: false,
      reason_code: SHIFT_CHANGE_REASON.NO_LONGER_SHIFT,
      reason: REASON_TEXT[SHIFT_CHANGE_REASON.NO_LONGER_SHIFT],
      payroll_locked,
    };
  }
  return {
    can_raise: true,
    reason_code: SHIFT_CHANGE_REASON.ELIGIBLE,
    reason: REASON_TEXT[SHIFT_CHANGE_REASON.ELIGIBLE],
    payroll_locked,
  };
}

/**
 * Everything the rule decides BEFORE a particular shift is named - the date
 * window, the payroll lock, the one-request-per-date key and the existence of
 * a permanent shift to change FROM. Returns a refusal verdict, or `null` when
 * nothing here blocks the date.
 *
 * IT IS SPLIT OUT SO THE TWO CALLERS SHARE THE ORDER AS WELL AS THE TESTS.
 * The employee path already holds a chosen `work_shift_id` and must validate
 * THAT shift (is it already theirs, does it have a schedule, does it run that
 * day) in between these gates and the longer-than test; the report holds no
 * chosen shift and asks whether ANY would do. Both run this first, in this
 * sequence, so a date refused for HR's reason is refused for the employee's.
 */
function decidePreconditions({
  attendance_date,
  today,
  payroll_locked = [],
  existing_request = null,
  // UNDEFINED MEANS "NOT YET READ", NULL MEANS "GENUINELY UNASSIGNED", and the
  // difference is load-bearing. The employee path calls this as each fact
  // arrives, so a caller that has not resolved the shift yet must not be told
  // there is no shift - it simply is not this call's turn to judge that.
  base_work_shift_id = undefined,
}) {
  const verdict = (reason_code, reason) => ({
    can_raise: false,
    reason_code,
    reason: reason || REASON_TEXT[reason_code] || "",
    payroll_locked,
  });

  if (attendance_date < addDays(today, -MAX_BACKDATE_DAYS)) {
    return verdict(SHIFT_CHANGE_REASON.TOO_OLD);
  }
  if (attendance_date > addDays(today, MAX_FORWARD_DAYS)) {
    return verdict(SHIFT_CHANGE_REASON.TOO_FAR_AHEAD);
  }

  // PAYROLL LOCK, BEFORE ANYTHING ELSE IS CONSIDERED. A date in a settled
  // month can no longer be recalculated by anybody, so a request for it could
  // never be approved - and the report must never invite HR to chase one.
  if (Array.isArray(payroll_locked) && payroll_locked.length > 0) {
    return verdict(
      SHIFT_CHANGE_REASON.PAYROLL_LOCKED,
      `A shift change for this date cannot be made because payroll for ${lockedMonthsLabel(
        payroll_locked
      )} is approved and locked.`
    );
  }

  // ONE OPEN OR APPROVED SHIFT REQUEST PER DATE. A REJECTED one does not
  // block a fresh attempt, here or in production.
  if (existing_request && existing_request.status !== "REJECTED") {
    const id = existing_request.attendance_approval_request_id;
    const pending = existing_request.status === "PENDING";
    return verdict(
      pending ? SHIFT_CHANGE_REASON.ALREADY_PENDING : SHIFT_CHANGE_REASON.ALREADY_APPROVED,
      `A shift change for ${attendance_date} ${
        pending ? "is already pending" : "has already been approved"
      } (#${id})`
    );
  }

  if (base_work_shift_id === null) {
    return verdict(
      SHIFT_CHANGE_REASON.NO_BASE_SHIFT,
      `You have no work shift assigned for ${attendance_date}, so there is no shift to change from`
    );
  }

  return null;
}

/**
 * DID THEY ACTUALLY WORK LONGER THAN THE ASSIGNED SHIFT?
 *
 * A SEPARATE QUESTION, deliberately kept out of `decide`. The report shows it
 * beside eligibility so HR can find the people who both MAY raise a request
 * and LOOK LIKE THEY NEED TO, but it authorises nothing: a day worked long
 * with no longer shift on the master is still not raisable.
 *
 * Measured against `base_nrm_minutes` - the PERMANENT shift's NRM for the
 * date, which is what the engine pays regular time against - and not against
 * an override's, so a day already calculated under an approved longer shift
 * does not read as "worked longer" a second time.
 */
function workedLongerThanAssigned({ worked_minutes, base_nrm_minutes }) {
  const worked = Number(worked_minutes);
  const nrm = Number(base_nrm_minutes);
  if (!Number.isFinite(worked) || !Number.isFinite(nrm) || nrm <= 0) return false;
  return worked > nrm;
}

module.exports = {
  MAX_BACKDATE_DAYS,
  MAX_FORWARD_DAYS,
  SHIFT_CHANGE_REASON,
  REASON_TEXT,
  addDays,
  nrmOfSnapshot,
  decidePreconditions,
  hasLongerShiftOption,
  lockedMonthsLabel,
  decide,
  workedLongerThanAssigned,
};
