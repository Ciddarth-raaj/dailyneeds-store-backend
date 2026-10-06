/**
 * PAYROLL READINESS - one answer to "can this employee's month be calculated,
 * and if not, exactly why not", used by EVERY payroll path that asks.
 *
 *   the Calculation & Review list status and its blockers
 *   the summary counts, including Calculate All Eligible (N)
 *   Calculate / Recalculate, individual and bulk
 *
 * ================================================================ WHY =====
 *
 * Payroll used to decide two things two different ways:
 *
 *   ELIGIBLE meant "initialized and not calculated" - nothing else was looked
 *   at, so Calculate All Eligible counted employees the calculation would then
 *   reject ("Approved OT does not reconcile").
 *
 *   ATTENDANCE PENDING meant `attendance_monthly_payroll.is_final = 0` - a flag
 *   on the monthly SUMMARY, which is written only by the month persist. Every
 *   other attendance write (a regularization or OT approval, a revocation, a
 *   punch void, a device-time correction, the daily recalculation) rewrites
 *   DAY ROWS only. A summary persisted while a day was still pending therefore
 *   kept saying "not final" after the day was settled, and Payroll kept saying
 *   "Attendance incomplete" about a month the Attendance screens showed as
 *   complete.
 *
 * ========================================================== WHAT IT DOES ==
 *
 * It reads attendance the way the Attendance module and Approve & Lock already
 * do - from the STORED DAY ROWS, with the summary checked against them by the
 * same fingerprint (`utils/attendance_month_freshness.js`) - and it reports
 * each problem by name, with the dates. It reconciles the approved OT exactly
 * as the calculation will (`utils/attendance_payroll.js` sums it over FINAL
 * days; the payrun prices it only on days with an NRM). And the caller passes
 * in the errors of a dry run of the real `computeCalculation`, so an employee
 * counted as ready is, by construction, one the calculation accepts.
 *
 * IT CHANGES NOTHING. It is pure: no read, no write, no inference that turns a
 * problem into a pass. A month whose summary is stale is reported STALE - it
 * is never treated as fresh because its days look fine - and the remedy is the
 * existing attendance engine, run deliberately (Process Attendance).
 */
const { monthFreshness } = require("./attendance_month_freshness");
const { availableDates } = require("./attendance_payroll");

const REASON = Object.freeze({
  ATTENDANCE_MONTH_NOT_CALCULATED: "ATTENDANCE_MONTH_NOT_CALCULATED",
  ATTENDANCE_STALE: "ATTENDANCE_STALE",
  /*
   * THE ATTENDANCE MONTH WAS PRICED ON A DIFFERENT SALARY. Its Salary Days
   * earnings, Extra Days amount and missing-hours deduction are money the
   * attendance engine priced with the approved salary it read when the month
   * was processed - and payroll takes them as they are. A revision approved
   * since leaves them on the old salary while the month's gross is the new
   * one, so the month is not paid on one salary until Process Attendance
   * re-prices it (same engine, same effective-dated rule).
   */
  ATTENDANCE_SALARY_STALE: "ATTENDANCE_SALARY_STALE",
  ATTENDANCE_DAY_ROWS_INCOMPLETE: "ATTENDANCE_DAY_ROWS_INCOMPLETE",
  ATTENDANCE_SUMMARY_NOT_FINAL: "ATTENDANCE_SUMMARY_NOT_FINAL",
  APPROVED_OT_MISMATCH: "APPROVED_OT_MISMATCH",
  NRM_MISMATCH: "NRM_MISMATCH",
  PENDING_ATTENDANCE_REGULARIZATION: "PENDING_ATTENDANCE_REGULARIZATION",
  PENDING_OT_APPROVAL: "PENDING_OT_APPROVAL",
  SALARY_NOT_READY: "SALARY_NOT_READY",
  /*
   * A PAYROLL HOLD, not an attendance problem: the employee's statutory setup
   * is incomplete (see `utils/payrun_eligibility.js#statutorySetupGaps`), so
   * PF / EPS cannot be calculated without guessing. Never accepted by Close
   * Attendance for Payroll and never cleared by Process Attendance - only by
   * HR completing the named fields in the Employee Master.
   */
  STATUTORY_SETUP_INCOMPLETE: "STATUTORY_SETUP_INCOMPLETE",
  CALCULATION_REJECTED: "CALCULATION_REJECTED",
});

const LABEL = Object.freeze({
  [REASON.ATTENDANCE_MONTH_NOT_CALCULATED]: "Attendance month not processed",
  [REASON.ATTENDANCE_STALE]: "Attendance changed since it was processed",
  [REASON.ATTENDANCE_SALARY_STALE]: "Attendance priced on a different salary",
  [REASON.ATTENDANCE_DAY_ROWS_INCOMPLETE]: "Attendance days not settled",
  [REASON.ATTENDANCE_SUMMARY_NOT_FINAL]: "Attendance summary not final",
  [REASON.APPROVED_OT_MISMATCH]: "Approved OT does not match the days",
  [REASON.NRM_MISMATCH]: "Approved OT on a day with no NRM",
  [REASON.PENDING_ATTENDANCE_REGULARIZATION]: "Pending attendance request",
  [REASON.PENDING_OT_APPROVAL]: "Pending OT approval",
  [REASON.SALARY_NOT_READY]: "Salary not ready",
  [REASON.STATUTORY_SETUP_INCOMPLETE]: "Statutory setup incomplete - on hold",
  [REASON.CALCULATION_REJECTED]: "Calculation would be rejected",
});

/**
 * Which problems the existing attendance engine can clear by re-processing
 * the month (no human decision needed), and which an explicit
 * Close Attendance for Payroll is allowed to accept.
 */
const PROCESSABLE = new Set([
  REASON.ATTENDANCE_MONTH_NOT_CALCULATED,
  REASON.ATTENDANCE_STALE,
  REASON.ATTENDANCE_SALARY_STALE,
  REASON.ATTENDANCE_SUMMARY_NOT_FINAL,
  REASON.APPROVED_OT_MISMATCH,
]);
const ACCEPTED_BY_CLOSE = new Set([
  REASON.ATTENDANCE_DAY_ROWS_INCOMPLETE,
  REASON.ATTENDANCE_SUMMARY_NOT_FINAL,
  REASON.PENDING_ATTENDANCE_REGULARIZATION,
  REASON.PENDING_OT_APPROVAL,
]);
const ATTENDANCE_REASONS = new Set([
  REASON.ATTENDANCE_MONTH_NOT_CALCULATED,
  REASON.ATTENDANCE_STALE,
  REASON.ATTENDANCE_SALARY_STALE,
  REASON.ATTENDANCE_DAY_ROWS_INCOMPLETE,
  REASON.ATTENDANCE_SUMMARY_NOT_FINAL,
  REASON.APPROVED_OT_MISMATCH,
  REASON.NRM_MISMATCH,
  REASON.PENDING_ATTENDANCE_REGULARIZATION,
  REASON.PENDING_OT_APPROVAL,
]);

const int0 = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
};
const isFinal = (v) => v === 1 || v === true || v === "1";
const pad = (n) => String(n).padStart(2, "0");
const shortList = (dates, max = 6) =>
  dates.length <= max ? dates.join(", ") : `${dates.slice(0, max).join(", ")} and ${dates.length - max} more`;

function datesBetween(from, to) {
  if (!from || !to) return [];
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * THE STATUTORY SETUP HOLD as a readiness reason, or null when nothing is
 * missing. One builder, so the list, Calculate's refusal and the approval
 * blocker all say the same thing.
 */
function statutoryHoldReason(gaps) {
  const list = Array.isArray(gaps) ? gaps : [];
  if (list.length === 0) return null;
  return reason(
    REASON.STATUTORY_SETUP_INCOMPLETE,
    `On hold - statutory setup incomplete: ${list.map((g) => g.label).join(", ")} not recorded. ` +
      "HR must complete these in Employee Master (Statutory details); the hold lifts on the next refresh and the employee can then be calculated. " +
      "Nothing is assumed in the meantime.",
    { missing_fields: list.map((g) => g.field) }
  );
}

function reason(code, message, extra = {}) {
  return {
    code,
    label: LABEL[code],
    message,
    processable: PROCESSABLE.has(code),
    accepted_by_close: ACCEPTED_BY_CLOSE.has(code),
    ...extra,
  };
}

/**
 * @param year, month          the payroll month
 * @param snapshot             the `payrun_employee` row (salary structure,
 *                             joining / resignation dates)
 * @param monthly              the stored `attendance_monthly_payroll` row, or
 *                             null; must carry `day_rows_fingerprint`
 * @param day_rows             the stored `attendance_day_calculation` rows of
 *                             the month, with the fingerprint fields and status
 * @param attendance_required  false for an employee exempt from biometric
 *                             attendance - their days decide nothing
 * @param pending              { pending_regularizations, pending_ot }
 * @param closed_for_payroll   an explicit Close Attendance for Payroll
 * @param latest_closed_date   'YYYY-MM-DD': the last date whose attendance day
 *                             can have closed (yesterday, IST)
 * @param calculation_errors   the errors a dry run of `computeCalculation`
 *                             produced for this employee, if any
 */
function evaluatePayrollReadiness(input = {}) {
  const {
    year,
    month,
    snapshot = {},
    monthly = null,
    day_rows = [],
    attendance_required = true,
    pending = {},
    closed_for_payroll = false,
    latest_closed_date = null,
    calculation_errors = [],
    /** `statutorySetupGaps` for this employee: what HR has still to record. */
    statutory_gaps = [],
  } = input;

  const reasons = [];
  const days = Array.isArray(day_rows) ? day_rows : [];

  /* ---------------------------------------------------------- salary */
  const salaryProblems = [];
  if (snapshot.monthly_gross === null || snapshot.monthly_gross === undefined || snapshot.monthly_gross === "") {
    salaryProblems.push("no approved monthly gross");
  }
  if (snapshot.basic === null || snapshot.basic === undefined || snapshot.basic === "") {
    salaryProblems.push("no Basic");
  }
  if (salaryProblems.length > 0) {
    reasons.push(
      reason(
        REASON.SALARY_NOT_READY,
        `This month's payroll snapshot has ${salaryProblems.join(" and ")}. ` +
          "Approve the Salary Master record effective for the month, then re-initialize the employee."
      )
    );
  }

  /* ------------------------------------------------------ attendance */
  if (!monthly) {
    reasons.push(
      reason(
        REASON.ATTENDANCE_MONTH_NOT_CALCULATED,
        "Attendance has not been processed for this month. Process Attendance to calculate it."
      )
    );
  } else {
    /*
     * ONE SALARY FOR THE MONTH. `snapshot` here is the snapshot as payroll
     * PRICES it - its salary is the approved salary applicable to the month -
     * and the attendance month carries the gross it was priced on. Compared in
     * paise; a month stored before the engine recorded its gross is not judged.
     */
    const paise = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
    const attendanceGross = paise(monthly.monthly_gross);
    const approvedGross = paise(snapshot.monthly_gross);
    if (attendanceGross !== null && approvedGross !== null && attendanceGross !== approvedGross) {
      const rupees = (p) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      reasons.push(
        reason(
          REASON.ATTENDANCE_SALARY_STALE,
          `The attendance month was processed on a monthly gross of ${rupees(attendanceGross)}, but the approved salary for this month is ${rupees(approvedGross)}. ` +
            "Process Attendance so the salary days, extra days and missing hours are priced on the approved salary, then Recalculate.",
          { attendance_gross: monthly.monthly_gross, approved_gross: snapshot.monthly_gross }
        )
      );
    }

    const freshness = monthFreshness({ monthly, dayRows: days });
    if (freshness.state === "STALE") {
      reasons.push(
        reason(
          REASON.ATTENDANCE_STALE,
          freshness.reason === "UNTRACKED"
            ? "The attendance summary was processed before change tracking existed, so it cannot be shown to match its days. Process Attendance once."
            : "Attendance days changed after the month was processed (an approval, a correction or a recalculation). Process Attendance to bring the summary up to date.",
          { stale_reason: freshness.reason }
        )
      );
    }

    if (attendance_required !== false) {
      const window = availableDates({
        year: Number(year),
        month: Number(month),
        joined_on: snapshot.date_of_joining || null,
        ended_on: snapshot.resignation_date || null,
      });
      const expected = datesBetween(window.from, window.to);
      const stored = new Set(days.map((d) => d.attendance_date));
      const notFinal = days
        .filter((d) => !isFinal(d.is_final) && (!window.from || (d.attendance_date >= window.from && d.attendance_date <= window.to)))
        .map((d) => ({ attendance_date: d.attendance_date, status: d.status || null }));
      const missing = expected.filter(
        (date) => !stored.has(date) && (latest_closed_date === null || date <= latest_closed_date)
      );
      const notClosed = latest_closed_date === null ? [] : expected.filter((date) => date > latest_closed_date);

      if (notFinal.length + missing.length + notClosed.length > 0) {
        const parts = [];
        if (notFinal.length > 0) {
          parts.push(
            `not settled: ${shortList(notFinal.map((d) => `${d.attendance_date} (${d.status || "pending"})`))}`
          );
        }
        if (missing.length > 0) parts.push(`not processed: ${shortList(missing)}`);
        if (notClosed.length > 0) parts.push(`not closed yet: ${shortList(notClosed)}`);
        reasons.push(
          reason(REASON.ATTENDANCE_DAY_ROWS_INCOMPLETE, `Attendance days ${parts.join("; ")}.`, {
            not_final_dates: notFinal,
            missing_dates: missing,
            not_closed_dates: notClosed,
            // Missing rows for CLOSED dates are filled by processing the month;
            // an unsettled day needs its request decided or its record fixed.
            processable: notFinal.length === 0 && notClosed.length === 0 && missing.length > 0,
          })
        );
      } else if (!isFinal(monthly.is_final)) {
        reasons.push(
          reason(
            REASON.ATTENDANCE_SUMMARY_NOT_FINAL,
            "Every attendance day is settled, but the monthly summary was processed before they were. Process Attendance to update it."
          )
        );
      }

      /*
       * APPROVED OT, RECONCILED EXACTLY AS THE TWO SIDES COMPUTE IT.
       * The summary sums approved OT over FINAL days
       * (`computeMonthlyAttendancePayroll`); the payrun prices it from final
       * days WITH AN NRM. Two separate failures, named separately.
       */
      const finalOtDays = days.filter((d) => isFinal(d.is_final) && int0(d.approved_ot_minutes) > 0);
      const dayOt = finalOtDays.reduce((t, d) => t + int0(d.approved_ot_minutes), 0);
      const summaryOt = int0(monthly.approved_ot_minutes);
      if (dayOt !== summaryOt) {
        reasons.push(
          reason(
            REASON.APPROVED_OT_MISMATCH,
            `The attendance summary has ${summaryOt} approved OT minutes but the settled days have ${dayOt}` +
              (finalOtDays.length > 0
                ? ` (${shortList(finalOtDays.map((d) => `${d.attendance_date}: ${int0(d.approved_ot_minutes)}`))})`
                : "") +
              ". Process Attendance so the summary matches its days.",
            { summary_ot_minutes: summaryOt, day_ot_minutes: dayOt }
          )
        );
      }
      const unrated = finalOtDays.filter((d) => int0(d.nrm_minutes) <= 0);
      if (unrated.length > 0) {
        reasons.push(
          reason(
            REASON.NRM_MISMATCH,
            `Approved OT is recorded on a day with no NRM, so it cannot be priced: ` +
              `${shortList(unrated.map((d) => `${d.attendance_date} (${int0(d.approved_ot_minutes)} min)`))}. ` +
              "Correct the shift or schedule for that date in Attendance, or revoke the OT, and recalculate the attendance.",
            { dates: unrated.map((d) => d.attendance_date) }
          )
        );
      }
    } else if (!isFinal(monthly.is_final)) {
      reasons.push(
        reason(
          REASON.ATTENDANCE_SUMMARY_NOT_FINAL,
          "The monthly attendance summary is not final. Process Attendance to update it."
        )
      );
    }
  }

  if (int0(pending.pending_regularizations) > 0) {
    reasons.push(
      reason(
        REASON.PENDING_ATTENDANCE_REGULARIZATION,
        `${int0(pending.pending_regularizations)} attendance request(s) in this month are still awaiting a decision.`
      )
    );
  }
  if (int0(pending.pending_ot) > 0) {
    reasons.push(
      reason(
        REASON.PENDING_OT_APPROVAL,
        `${int0(pending.pending_ot)} OT request(s) in this month are still awaiting a decision.`
      )
    );
  }

  /* ----------------------------------------- the statutory setup hold */
  const hold = statutoryHoldReason(statutory_gaps);
  if (hold) reasons.push(hold);

  /* ---------------------------------- the calculation's own verdict */
  const errors = (Array.isArray(calculation_errors) ? calculation_errors : []).filter(Boolean);
  const explained = reasons.some((r) =>
    [REASON.SALARY_NOT_READY, REASON.APPROVED_OT_MISMATCH, REASON.NRM_MISMATCH].includes(r.code)
  );
  if (errors.length > 0 && !explained) {
    reasons.push(reason(REASON.CALCULATION_REJECTED, errors.join("; ")));
  }

  /* ----------------------------------------------------- the verdict */
  const blocking = reasons.filter(
    (r) => !(closed_for_payroll === true && r.accepted_by_close)
  );
  const attendanceBlocking = blocking.filter((r) => ATTENDANCE_REASONS.has(r.code));
  return {
    // Attendance may be paid on: settled and current, or explicitly accepted.
    attendance_ready: attendanceBlocking.length === 0,
    // Every check the calculation itself makes passes.
    calculable: blocking.length === 0 && errors.length === 0,
    // Process Attendance would help: at least one blocker it can clear.
    attendance_processable: blocking.some((r) => r.processable),
    reasons: blocking,
    accepted_by_close: reasons.filter((r) => !blocking.includes(r)),
  };
}

module.exports = {
  statutoryHoldReason,
  READINESS_REASON: REASON,
  READINESS_LABEL: LABEL,
  evaluatePayrollReadiness,
  datesBetween,
};
