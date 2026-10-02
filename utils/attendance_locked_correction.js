/**
 * Locked-period attendance correction - the PAYROLL DIFFERENCE of correcting
 * one attendance date inside a payroll month that is already
 * `APPROVED_LOCKED`.
 *
 * The frozen payrun row is never re-priced or touched. This prices only the
 * change ONE corrected day makes, on THAT ROW'S OWN BASIS (its daily rate),
 * with the same rules the payroll used:
 *
 *   attendance days   attendance_day_count x daily rate. A day counts whether
 *                     or not it is final (`utils/attendance_payroll.js`), and
 *                     total attendance pay is attended days x daily rate
 *                     whichever side of the base the day falls on.
 *   missing minutes   shortage x (daily rate / that day's NRM minutes), final
 *                     days only.
 *   approved OT       minutes / 60 x (daily rate / NRM hours) - the payrun's
 *                     own formula (`utils/payrun_calculation.js`), no weekday
 *                     multiplier - final days only.
 *
 * PF and ESI are NOT recomputed. The difference is settled manually in a
 * later month through the existing adjustment fields (Arrears for a payable
 * amount, a recovery component for a recoverable one), and those carry no
 * PF/ESI by their own definition - so `statutory_recomputed: false` is stated
 * on every result rather than implied.
 *
 * Pure: no database, no clock.
 */

const DIRECTION = Object.freeze({
  PAYABLE_TO_EMPLOYEE: "PAYABLE_TO_EMPLOYEE",
  RECOVERABLE_FROM_EMPLOYEE: "RECOVERABLE_FROM_EMPLOYEE",
  NO_DIFFERENCE: "NO_DIFFERENCE",
});

const ADJUSTMENT_STATUS = Object.freeze({
  PENDING_ADJUSTMENT: "PENDING_ADJUSTMENT",
  SETTLED: "SETTLED",
  NOT_REQUIRED: "NOT_REQUIRED",
});

const int0 = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const toPaise = (rupees) => {
  const n = Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const toRupees = (paise) => Math.round(paise) / 100;
const isFinal = (day) => !!day && (day.is_final === true || Number(day.is_final) === 1);

/** What ONE day contributes, in paise, on a given daily rate. */
function dayContribution(day, dailyRatePaise) {
  const days = day ? int0(day.attendance_day_count) : 0;
  const final = isFinal(day);
  const nrm = day ? int0(day.nrm_minutes) : 0;
  const shortage = final ? int0(day.shortage_minutes) : 0;
  const approvedOt = final ? int0(day.approved_ot_minutes) : 0;
  const perMinute = nrm > 0 ? dailyRatePaise / nrm : null;
  return {
    attendance_day_count: days,
    shortage_minutes: shortage,
    approved_ot_minutes: approvedOt,
    nrm_minutes: nrm,
    days_paise: days * dailyRatePaise,
    missing_paise: perMinute === null ? 0 : shortage * perMinute,
    ot_paise: nrm > 0 ? Math.round((approvedOt / 60) * (dailyRatePaise / (nrm / 60))) : 0,
    unrated: perMinute === null && (shortage > 0 || approvedOt > 0),
  };
}

/**
 * THE OT CHANGE AS THE PAYRUN WOULD HAVE PRICED IT. The payrun rounds once per
 * NRM group, on the month's group total - so where the frozen row carries its
 * `ot_groups`, the day's minutes move between that group's old and new totals
 * and each total is rounded exactly as the payrun rounds it. Without groups
 * (a month that had no approved OT), the day is priced on its own.
 */
function otDifferencePaise(frozen, before, after, dailyRatePaise) {
  let groups = frozen && frozen.ot_groups;
  if (typeof groups === "string") {
    try {
      groups = JSON.parse(groups);
    } catch (e) {
      groups = null;
    }
  }
  const minutesByNrm = new Map();
  (Array.isArray(groups) ? groups : []).forEach((g) => {
    const nrm = int0(g.nrm_minutes);
    if (nrm > 0) minutesByNrm.set(nrm, (minutesByNrm.get(nrm) || 0) + int0(g.approved_ot_minutes));
  });
  const price = (minutes, nrm) => (nrm > 0 ? Math.round((minutes / 60) * (dailyRatePaise / (nrm / 60))) : 0);

  const touched = new Set([before.nrm_minutes, after.nrm_minutes].filter((n) => n > 0));
  let diff = 0;
  touched.forEach((nrm) => {
    const oldTotal = minutesByNrm.has(nrm) ? minutesByNrm.get(nrm) : before.nrm_minutes === nrm ? before.approved_ot_minutes : 0;
    const newTotal =
      oldTotal -
      (before.nrm_minutes === nrm ? before.approved_ot_minutes : 0) +
      (after.nrm_minutes === nrm ? after.approved_ot_minutes : 0);
    diff += price(Math.max(0, newTotal), nrm) - price(Math.max(0, oldTotal), nrm);
  });
  return diff;
}

/**
 * @param {object} input
 * @param {object} input.frozen  the APPROVED_LOCKED payrun_employee_calculation
 *   row: `daily_rate` at least; `payrun_calculation_id`, `calculation_hash`,
 *   `net_pay` are carried onto the result for the audit record
 * @param {object|null} input.old_day  the stored day row before the change
 * @param {object|null} input.new_day  the day as the change leaves it
 * @returns {object} the priced difference; `net_difference` > 0 is payable to
 *   the employee, < 0 recoverable from them
 */
function priceLockedDayCorrection({ frozen, old_day, new_day }) {
  const dailyRatePaise = frozen ? toPaise(frozen.daily_rate) : null;
  if (dailyRatePaise === null || dailyRatePaise <= 0) {
    const err = new Error(
      "The locked payroll month has no daily rate to price this correction against; it cannot be settled automatically"
    );
    err.name = "ValidationError";
    err.code = "LOCKED_CORRECTION_UNPRICEABLE";
    throw err;
  }
  const before = dayContribution(old_day, dailyRatePaise);
  const after = dayContribution(new_day, dailyRatePaise);
  if (before.unrated || after.unrated) {
    const err = new Error("A day with no NRM cannot be priced; this correction cannot be settled automatically");
    err.name = "ValidationError";
    err.code = "LOCKED_CORRECTION_UNPRICEABLE";
    throw err;
  }

  const daysPaise = after.days_paise - before.days_paise;
  // A larger deduction is LESS pay, so its change enters with a minus sign.
  const missingPaise = Math.round(after.missing_paise) - Math.round(before.missing_paise);
  const otPaise = otDifferencePaise(frozen, before, after, dailyRatePaise);
  const netPaise = daysPaise - missingPaise + otPaise;

  const direction =
    netPaise > 0
      ? DIRECTION.PAYABLE_TO_EMPLOYEE
      : netPaise < 0
      ? DIRECTION.RECOVERABLE_FROM_EMPLOYEE
      : DIRECTION.NO_DIFFERENCE;

  return {
    basis: {
      payrun_calculation_id:
        frozen.payrun_calculation_id === undefined ? null : Number(frozen.payrun_calculation_id),
      calculation_hash: frozen.calculation_hash || null,
      daily_rate: toRupees(dailyRatePaise),
      frozen_net_pay: frozen.net_pay === undefined || frozen.net_pay === null ? null : Number(frozen.net_pay),
    },
    components: {
      attendance_days: {
        before: before.attendance_day_count,
        after: after.attendance_day_count,
        amount: toRupees(daysPaise),
      },
      missing_minutes: {
        before: before.shortage_minutes,
        after: after.shortage_minutes,
        // Signed as its effect on PAY: more missing minutes is negative.
        amount: toRupees(-missingPaise),
      },
      approved_ot: {
        before: before.approved_ot_minutes,
        after: after.approved_ot_minutes,
        amount: toRupees(otPaise),
      },
    },
    net_difference: toRupees(netPaise),
    absolute_amount: toRupees(Math.abs(netPaise)),
    direction,
    adjustment_status:
      direction === DIRECTION.NO_DIFFERENCE ? ADJUSTMENT_STATUS.NOT_REQUIRED : ADJUSTMENT_STATUS.PENDING_ADJUSTMENT,
    statutory_recomputed: false,
  };
}

/** The attendance figures an audit record keeps for "old" and "new". */
function attendanceSummary(day) {
  if (!day) return null;
  const pick = (k) => (day[k] === undefined ? null : day[k]);
  return {
    attendance_date: pick("attendance_date"),
    status: pick("status"),
    is_final: isFinal(day),
    punch_count: pick("punch_count"),
    effective_punches: Array.isArray(day.effective_punches)
      ? day.effective_punches.map((p) => ({ io_time: p.io_time, source: p.source || null }))
      : typeof day.effective_punches === "string"
      ? (() => {
          try {
            return JSON.parse(day.effective_punches).map((p) => ({ io_time: p.io_time, source: p.source || null }));
          } catch (e) {
            return null;
          }
        })()
      : null,
    attendance_day_count: pick("attendance_day_count"),
    nrm_minutes: pick("nrm_minutes"),
    worked_minutes: pick("worked_minutes"),
    break_charged_minutes: pick("break_charged_minutes"),
    shortage_minutes: pick("shortage_minutes"),
    excess_ot_minutes: pick("excess_ot_minutes"),
    candidate_ot_minutes: pick("candidate_ot_minutes"),
    approved_ot_minutes: pick("approved_ot_minutes"),
  };
}

const OUTSTANDING_LABEL = Object.freeze({
  NETTED_OFF: "NETTED_OFF — no payroll adjustment required",
  SETTLED: "Settled",
  NONE: "No adjustment required",
});

/**
 * DERIVED, never stored: an event still PENDING_ADJUSTMENT whose request's
 * unsettled events net to exactly zero reads NETTED_OFF - no payroll work.
 */
const NETTED_OFF = "NETTED_OFF";

/**
 * THE OUTSTANDING ADJUSTMENT of ONE correction request - DERIVED, never
 * stored. The events stay exactly as written (append-only); this nets what is
 * still unsettled:
 *
 *   unsettled = the request's events still PENDING_ADJUSTMENT
 *   net       = their signed sum (paise, so 66.66 - 66.66 is exactly 0)
 *
 * An event already SETTLED was applied in a payroll and is NOT netted away:
 * approve -> settle -> revoke leaves the revoke's opposite amount outstanding
 * on its own. approve -> revoke before settlement nets to 0 and nothing is
 * actionable.
 *
 * @param {Array<{attendance_locked_period_correction_event_id, event_type,
 *   net_difference, adjustment_status}>} events  one request's events
 */
function outstandingAdjustment(events) {
  const list = Array.isArray(events) ? events : [];
  const unsettled = list.filter((e) => e.adjustment_status === ADJUSTMENT_STATUS.PENDING_ADJUSTMENT);
  const paise = unsettled.reduce((total, e) => total + Math.round((Number(e.net_difference) || 0) * 100), 0);
  const direction =
    paise > 0 ? DIRECTION.PAYABLE_TO_EMPLOYEE : paise < 0 ? DIRECTION.RECOVERABLE_FROM_EMPLOYEE : DIRECTION.NO_DIFFERENCE;
  const nettedOff = unsettled.length > 0 && paise === 0;
  const anySettled = list.some((e) => e.adjustment_status === ADJUSTMENT_STATUS.SETTLED);
  let label = null;
  let state = "OUTSTANDING";
  if (paise === 0) {
    if (nettedOff) {
      label = OUTSTANDING_LABEL.NETTED_OFF;
      state = NETTED_OFF;
    } else if (anySettled) {
      label = OUTSTANDING_LABEL.SETTLED;
      state = "SETTLED";
    } else {
      label = OUTSTANDING_LABEL.NONE;
      state = "NONE";
    }
  }
  return {
    state,
    net_difference: paise / 100,
    absolute_amount: Math.abs(paise) / 100,
    direction,
    actionable: paise !== 0,
    netted_off: nettedOff,
    pending_event_ids: unsettled.map((e) => Number(e.attendance_locked_period_correction_event_id)),
    label,
  };
}

/**
 * Each event of ONE request with its DERIVED `effective_adjustment_status`:
 * the stored status, except NETTED_OFF for a pending event inside a net of
 * zero. The stored columns are returned untouched beside it.
 */
function withEffectiveStatus(events) {
  const list = Array.isArray(events) ? events : [];
  const o = outstandingAdjustment(list);
  return list.map((e) => ({
    ...e,
    effective_adjustment_status:
      o.netted_off && e.adjustment_status === ADJUSTMENT_STATUS.PENDING_ADJUSTMENT ? NETTED_OFF : e.adjustment_status,
  }));
}

module.exports = {
  DIRECTION,
  ADJUSTMENT_STATUS,
  OUTSTANDING_LABEL,
  NETTED_OFF,
  outstandingAdjustment,
  withEffectiveStatus,
  priceLockedDayCorrection,
  attendanceSummary,
};
