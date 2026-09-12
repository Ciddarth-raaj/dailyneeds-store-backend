/**
 * Attendance v2 / A4 - monthly payroll consumption of calculated attendance.
 *
 * PURE FUNCTIONS ONLY, and MONEY IS HELD IN PAISE, for the same two reasons
 * `utils/salary_engine.js` gives: the whole business rule becomes testable
 * arithmetic, and integer paise means the parts sum to the whole exactly
 * rather than to within a floating-point epsilon.
 *
 * THIS FILE IS NOT A SECOND SALARY SOURCE. It never decides what anybody
 * earns. The Monthly Gross it works from is handed in by the caller, which
 * gets it from the existing effective-dated resolver
 * (`repository/employee_salary.js#getCurrentSalary` - the latest APPROVED
 * record effective on or before the date). There is exactly one authoritative
 * answer to "what is this person's salary", and it is not here.
 *
 * THE OPERATING MODEL, as approved in v2:
 *
 *   - No weekly-off payroll rule and no paid-leave payroll rule. A day is paid
 *     because it was attended, not because the roster said it was a working
 *     day.
 *   - Daily Rate = Monthly Gross / 26.
 *   - Pay before minute deductions = Attendance Days x Daily Rate.
 *   - The shortfall is a SEPARATE, minute-based deduction. A day is never
 *     downgraded to a half day, and there is no second monetary penalty for
 *     lateness - that would deduct the same minute twice.
 *
 * THE SALARY-DAY / EXTRA-DAY SPLIT exists for statutory filing, not for pay.
 * Total attendance pay is `attended_days x Daily Rate` either way; the split
 * only decides how much of it is the PF/ESI salary-day base:
 *
 *     available_dates = the dates in the month the employee could have worked,
 *                       bounded by joining date and last working date
 *     notional_offs   = floor(available_dates / 7)
 *     base_days       = available_dates - notional_offs
 *     salary_days     = min(attended_days, base_days)
 *     extra_days      = max(attended_days - base_days, 0)
 *
 * THE STATUTORY HANDOFF. `statutory_base_earnings` below is the Salary Days
 * line and nothing else; Extra Days are excluded from it by construction.
 * This file does NOT recompute PF or ESI - `utils/salary_engine.js` owns that
 * law and is not touched. What is produced here is the wage base that engine
 * should be given for a period, and the field is named so that the handoff is
 * explicit rather than inferred.
 */

const SALARY_DAYS_PER_MONTH = require("../config/statutory").salary.salaryDaysPerMonth;

/** Bumped whenever a stored monthly result would come out differently. */
const PAYROLL_VERSION = 1;

/**
 * Rupees (or a numeric string) -> integer paise, or null.
 *
 * null, undefined and "" come back as NULL rather than as zero, deliberately.
 * `Number(null)` is 0, and a missing salary silently becoming a zero daily
 * rate would produce a plausible-looking month of nil pay instead of the
 * visible "no salary on record" the rest of this file propagates.
 */
const toPaise = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Integer paise -> a rupee number with two decimals. */
const toRupees = (paise) =>
  paise === null || paise === undefined ? null : Math.round(paise) / 100;

/** `YYYY-MM-DD` from a string or Date, else null. */
function toDateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Days in a calendar month, by UTC math. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * The dates in the month the employee could have worked.
 *
 * Bounded by the joining date and the last working date, so a mid-month joiner
 * is not judged against a whole month's `base_days` and a leaver is not either.
 * Both bounds are inclusive; a joining date after the month, or a leaving date
 * before it, gives zero.
 */
function availableDates({ year, month, joined_on = null, ended_on = null }) {
  const total = daysInMonth(year, month);
  const monthStart = `${year}-${pad(month)}-01`;
  const monthEnd = `${year}-${pad(month)}-${pad(total)}`;

  const start = toDateOnly(joined_on);
  const end = toDateOnly(ended_on);

  const from = start !== null && start > monthStart ? start : monthStart;
  const to = end !== null && end < monthEnd ? end : monthEnd;
  if (from > to) return { count: 0, from: null, to: null };

  const dayOf = (s) => Number(s.slice(8, 10));
  return { count: dayOf(to) - dayOf(from) + 1, from, to };
}

/**
 * The salary-day / extra-day split. Pure integer arithmetic on day counts.
 */
function splitSalaryAndExtraDays(attendedDays, availableDateCount) {
  const available = Math.max(0, Math.trunc(availableDateCount || 0));
  const attended = Math.max(0, Math.trunc(attendedDays || 0));
  const notionalOffs = Math.floor(available / 7);
  const baseDays = Math.max(0, available - notionalOffs);
  return {
    available_dates: available,
    notional_offs: notionalOffs,
    base_days: baseDays,
    attendance_days: attended,
    salary_days: Math.min(attended, baseDays),
    extra_days: Math.max(attended - baseDays, 0),
  };
}

/**
 * Per-minute rate for ONE date: Daily Rate / that date's NRM minutes.
 *
 * It is per DATE and not per month on purpose. An employee on a 12-hour shift
 * owes more minutes for the same daily rate than one on an 8-hour shift, so a
 * missing 30 minutes is worth less on the long shift. Dividing by a monthly
 * average would over-deduct one and under-deduct the other.
 *
 * Returned in paise-per-minute as an unrounded float; the rounding happens
 * once, on the summed deduction, so twenty small shortfalls do not each carry
 * their own rounding error.
 */
function perMinutePaise(dailyRatePaise, nrmMinutes) {
  const nrm = Math.trunc(nrmMinutes || 0);
  if (!Number.isFinite(dailyRatePaise) || nrm <= 0) return null;
  return dailyRatePaise / nrm;
}

/**
 * Roll up a month of calculated dates into the payroll line items.
 *
 * @param {object} input
 * @param {number} input.employee_id
 * @param {number} input.year
 * @param {number} input.month                1-12
 * @param {number} input.monthly_gross        from the M2/M4 salary resolver
 * @param {Array}  input.days                 `calculateAttendanceDay` results
 * @param {string|null} [input.joined_on]
 * @param {string|null} [input.ended_on]
 * @returns {object} the stable monthly contract
 */
function computeMonthlyAttendancePayroll(input = {}) {
  const {
    employee_id = null,
    year = null,
    month = null,
    monthly_gross = null,
    days = [],
    joined_on = null,
    ended_on = null,
  } = input;

  const grossPaise = toPaise(monthly_gross);
  const salaryDaysPerMonth = Math.max(1, Number(SALARY_DAYS_PER_MONTH) || 26);
  const dailyRatePaise = grossPaise === null ? null : grossPaise / salaryDaysPerMonth;

  const window = availableDates({ year, month, joined_on, ended_on });

  let attendedDays = 0;
  let shortageMinutes = 0;
  let approvedOtMinutes = 0;
  let deductionPaise = 0;
  let otEarningsPaise = 0;
  const heldDates = [];
  const unratedDates = [];

  (days || []).forEach((day) => {
    if (!day) return;
    attendedDays += Math.max(0, Math.trunc(day.attendance_day_count || 0));

    // A date that is not final is PRESENT but not settled. Its day still
    // counts - the employee was demonstrably at work - while its shortage and
    // its OT are held out of payroll until the A3 chain finishes, because both
    // are computed from a punch list that is known to be incomplete.
    if (day.is_final !== true) {
      heldDates.push(day.attendance_date);
      return;
    }

    const shortage = Math.max(0, Math.trunc(day.shortage_minutes || 0));
    const approvedOt = Math.max(0, Math.trunc(day.approved_ot_minutes || 0));
    shortageMinutes += shortage;
    approvedOtMinutes += approvedOt;

    if (dailyRatePaise === null) return;

    const perMinute = perMinutePaise(dailyRatePaise, day.nrm_minutes);
    if (perMinute === null) {
      // NRM of zero would be a divide by zero. It means a rest day or a
      // misconfigured schedule; the minutes are reported and charged nothing
      // rather than silently priced off some other date's shift.
      if (shortage > 0 || approvedOt > 0) unratedDates.push(day.attendance_date);
      return;
    }

    deductionPaise += shortage * perMinute;

    // OT base hourly rate = (Gross/26) / NRM hours, which per MINUTE is the
    // very same Daily Rate / NRM minutes as the shortage rate - calculated in
    // minutes throughout, as v2 requires - then multiplied by the Work Shift's
    // own OT rate for that weekday.
    const otRate = Number(day.ot_rate);
    otEarningsPaise += approvedOt * perMinute * (Number.isFinite(otRate) ? otRate : 1);
  });

  const split = splitSalaryAndExtraDays(attendedDays, window.count);

  const salaryEarningsPaise =
    dailyRatePaise === null ? null : Math.round(split.salary_days * dailyRatePaise);
  const extraEarningsPaise =
    dailyRatePaise === null ? null : Math.round(split.extra_days * dailyRatePaise);
  const deduction = dailyRatePaise === null ? null : Math.round(deductionPaise);
  const otEarnings = dailyRatePaise === null ? null : Math.round(otEarningsPaise);

  const totalPayable =
    dailyRatePaise === null
      ? null
      : salaryEarningsPaise + extraEarningsPaise + otEarnings - deduction;

  return {
    payroll_version: PAYROLL_VERSION,
    employee_id,
    period_year: year,
    period_month: month,

    // The window, so the day counts can be audited without re-deriving them.
    available_from: window.from,
    available_to: window.to,
    available_dates: split.available_dates,
    notional_offs: split.notional_offs,
    base_days: split.base_days,

    attendance_days: split.attendance_days,
    salary_days: split.salary_days,
    extra_days: split.extra_days,

    monthly_gross: toRupees(grossPaise),
    daily_rate: dailyRatePaise === null ? null : toRupees(Math.round(dailyRatePaise)),

    salary_earnings: toRupees(salaryEarningsPaise),
    extra_day_earnings: toRupees(extraEarningsPaise),

    shortage_minutes: shortageMinutes,
    missing_minute_deduction: toRupees(deduction),

    approved_ot_minutes: approvedOtMinutes,
    approved_ot_earnings: toRupees(otEarnings),

    // THE STATUTORY HANDOFF (v2). This, and not the total, is the PF/ESI
    // salary-day base: Extra Days are excluded by construction. It is exposed
    // for the existing statutory engine to consume; no PF or ESI formula is
    // recomputed in this file.
    statutory_base_days: split.salary_days,
    statutory_base_earnings: toRupees(salaryEarningsPaise),

    total_attendance_payable: toRupees(totalPayable),

    // Dates payroll must NOT treat as settled, named rather than counted, so
    // the eventual screen can link straight to them.
    held_dates: heldDates,
    unrated_dates: unratedDates,
    is_final: heldDates.length === 0,
  };
}

module.exports = {
  PAYROLL_VERSION,
  toPaise,
  toRupees,
  toDateOnly,
  daysInMonth,
  availableDates,
  splitSalaryAndExtraDays,
  perMinutePaise,
  computeMonthlyAttendancePayroll,
};
