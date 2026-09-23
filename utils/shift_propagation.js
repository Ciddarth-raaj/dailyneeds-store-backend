/**
 * WHICH ATTENDANCE DATES A WORK SHIFT RULE CHANGE REACHES.
 *
 * PURE FUNCTIONS ONLY. No database, no Express, no clock: the caller supplies
 * the facts and today's date, which is what lets the whole business rule be
 * tested as arithmetic.
 *
 * THE RULE. When a shift's calculating configuration changes, every
 * attendance date that WOULD BE CALCULATED under that shift and whose payroll
 * month is still OPEN must be recalculated - whether or not anybody has ever
 * calculated it before. Applicability therefore comes from the DATED FACTS -
 * the employee -> shift assignment history, the single-date shift overrides
 * and the employment bounds - and NOT from the existence of a stored
 * `attendance_day_calculation` row. A date that has never been calculated is
 * exactly the date most in need of being calculated under the new rule.
 *
 * THE FOUR BOUNDS, all of them upper or lower limits on the same set:
 *
 *   1. THE ASSIGNMENT. The employee had this shift on that date - the A0
 *      effective-dated history, read exactly as the calculation reads it:
 *      an assignment governs from its `effective_from` until the next one.
 *      A single-date override TO this shift adds that date; a date assigned
 *      to this shift but overridden AWAY from it is still included, because
 *      this shift remains the PERMANENT shift its regular time, its overtime
 *      split and its shortage are measured against.
 *   2. EMPLOYMENT. Joining and resignation, through the one shared rule in
 *      `utils/attendance_eligibility.js`. Somebody exempt from attendance
 *      contributes nothing at all.
 *   3. THE CLOSED-DAY RULE. Never a date whose attendance day is still open,
 *      and so never today or a future date: a stored row for an open day is a
 *      snapshot of a half-finished day that would later be read back as
 *      history. Today can never have closed (a date closes at its following
 *      midnight at the earliest), so the scope ends YESTERDAY at the latest -
 *      `latestClosableDate`. Whether yesterday itself has closed depends on
 *      that employee's shift cutoff on that date, which only the calculation
 *      resolves: `recalculateRange` applies `isDayClosed` per date and
 *      persists only the closed ones (`utils/attendance_persist_guard.js`).
 *   4. THE PAYROLL LOCK, MONTH BY MONTH. A month is skipped if and only if
 *      THAT employee's payroll for THAT month is approved and locked. It is
 *      NOT inferred from any other month: payroll having settled August says
 *      nothing about July, and a July that is still open must receive the new
 *      rule like any other open month. Every skipped month is counted, with
 *      the days it holds, so a skip is never silent. The only absolute floor
 *      is the v2 cutover, before which no attendance date exists at all.
 *
 * WHAT COMES OUT is month-sized work: one bucket per (employee, calendar
 * month), because the payroll lock is a monthly fact and because the
 * recalculation path takes a range. A month of somebody's dates is one call
 * rather than thirty.
 */

const { toDateOnly } = require("./shiftResolution");
const eligibility = require("./attendance_eligibility");
const { V2_CUTOVER_DATE } = require("../constants/attendance_v2");
const { latestClosableDate } = require("./attendance_persist_guard");

/** `YYYY-MM` of a date. String compare is date compare. */
const monthOf = (date) => String(date).slice(0, 7);

/** The first day of the month after `YYYY-MM`. */
function monthAfter(month) {
  const y = Number(String(month).slice(0, 4));
  const m = Number(String(month).slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** The last day of the month a date falls in. */
function endOfMonth(date) {
  const next = monthAfter(monthOf(date));
  const d = new Date(`${next}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The first day of the month a date falls in. */
const startOfMonth = (date) => `${monthOf(date)}-01`;

/**
 * The half-open intervals during which this employee was assigned to
 * `workShiftId`, from their WHOLE assignment history.
 *
 * The history is read the same way `resolveAssignmentForDate` reads it -
 * ordered by `effective_from` and then by id, each row governing until the
 * next - so "which shift on this date" answers the same question here and in
 * the engine. Two rows on the same day are the same tie-break: the later id
 * wins, and the earlier one governs nothing.
 */
function assignedIntervals(assignments, workShiftId) {
  const ordered = (assignments || [])
    .map((row) => ({
      effective_from: toDateOnly(row.effective_from),
      work_shift_id: Number(row.work_shift_id),
      id: Number(row.employee_work_shift_assignment_id) || 0,
    }))
    .filter((row) => row.effective_from !== null)
    .sort((a, b) =>
      a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : a.id - b.id
    );

  // Same-day rows collapse to the last one, which is the one that governs.
  const governing = [];
  ordered.forEach((row) => {
    const last = governing[governing.length - 1];
    if (last && last.effective_from === row.effective_from) governing[governing.length - 1] = row;
    else governing.push(row);
  });

  const intervals = [];
  governing.forEach((row, index) => {
    if (row.work_shift_id !== Number(workShiftId)) return;
    const next = governing[index + 1];
    intervals.push({
      from: row.effective_from,
      // Open-ended until the next assignment starts; `null` means "still".
      to: next ? addDaysUtc(next.effective_from, -1) : null,
    });
  });
  return intervals;
}

/** Date arithmetic on `YYYY-MM-DD`, in UTC so no timezone can shift a day. */
function addDaysUtc(date, days) {
  const d = new Date(`${toDateOnly(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The work a shift rule change creates for ONE employee, as month buckets.
 *
 * @param {object} employee        employment facts: attendance_required, joining, resignation
 * @param {object[]} assignments   that employee's WHOLE assignment history
 * @param {string[]} overrideDates single-date overrides ONTO this shift
 * @param {string[]} lockedMonths  `YYYY-MM` months payroll has locked for them
 * @param {number} workShiftId
 * @param {string} today  the IST business date now; the scope ends the day
 *                         before it (`latestClosableDate`)
 * @returns {{buckets: object[], skipped_locked_months: string[]}}
 */
function propagationForEmployee({
  employee,
  assignments,
  overrideDates = [],
  lockedMonths = [],
  lockedAt = {},
  workShiftId,
  today,
  cutover = V2_CUTOVER_DATE,
}) {
  const end = latestClosableDate(today);
  if (end === null) return { buckets: [], skipped_locked_months: [] };

  const lockedSet = new Set(lockedMonths || []);

  // The dates this shift decides, as ranges: the assignment intervals, plus
  // one-day ranges for the overrides onto this shift.
  const ranges = [
    ...assignedIntervals(assignments, workShiftId),
    ...(overrideDates || [])
      .map((date) => toDateOnly(date))
      .filter((date) => date !== null)
      .map((date) => ({ from: date, to: date })),
  ];

  // Clamped to the latest closable date, to the cutover and to employment -
  // the shared rule, not a fourth copy of a bound. The payroll lock is applied per MONTH
  // below, against this window, so that what it removes is reported as
  // skipped rather than silently vanishing.
  const applicable = [];
  ranges.forEach((range) => {
    const from = range.from > cutover ? range.from : cutover;
    const to = range.to === null || range.to > end ? end : range.to;
    if (from > to) return;
    const window = eligibility.eligibleWindow(employee, from, to);
    if (window) applicable.push(window);
  });

  // Every locked month this shift would otherwise have reached - WITH the
  // days it holds, so "Y locked days skipped" is a number and not a shrug.
  // ONE MONTH'S LOCK SAYS NOTHING ABOUT ANOTHER'S: August being settled does
  // not close July, and July is recalculated if July is open.
  const skippedByLock = new Map();
  (lockedMonths || []).forEach((month) => {
    const monthStart = `${month}-01`;
    const monthEnd = endOfMonth(monthStart);
    applicable.forEach((range) => {
      if (range.from > monthEnd || range.to < monthStart) return;
      const from = range.from > monthStart ? range.from : monthStart;
      const to = range.to < monthEnd ? range.to : monthEnd;
      const existing = skippedByLock.get(month);
      if (!existing) {
        skippedByLock.set(month, { month, from_date: from, to_date: to });
      } else {
        if (from < existing.from_date) existing.from_date = from;
        if (to > existing.to_date) existing.to_date = to;
      }
    });
  });



  // Split into calendar months, dropping the locked ones. Overlapping ranges
  // - an override inside its own assignment interval - merge into one bucket
  // per month rather than recalculating the month twice.
  const buckets = new Map();
  const skipped = new Set(skippedByLock.keys());
  applicable.forEach((range) => {
    let cursor = range.from;
    let guard = 0;
    while (cursor <= range.to && guard <= 400) {
      const month = monthOf(cursor);
      const monthEnd = endOfMonth(cursor);
      const sliceTo = monthEnd < range.to ? monthEnd : range.to;
      if (lockedSet.has(month)) {
        skipped.add(month);
      } else {
        const existing = buckets.get(month);
        if (!existing) {
          buckets.set(month, { month, from_date: cursor, to_date: sliceTo });
        } else {
          if (cursor < existing.from_date) existing.from_date = cursor;
          if (sliceTo > existing.to_date) existing.to_date = sliceTo;
        }
      }
      cursor = addDaysUtc(monthEnd, 1);
      guard += 1;
    }
  });

  return {
    buckets: [...buckets.values()]
      .sort((a, b) => (a.month < b.month ? -1 : 1))
      .map((bucket) => ({
        ...bucket,
        period_year: Number(bucket.month.slice(0, 4)),
        period_month: Number(bucket.month.slice(5, 7)),
        // Every date of the bucket is recalculated, including the ones that
        // never had a stored row: the whole point of discovering from the
        // assignment rather than from what happens to be stored.
        day_count: dayCount(bucket.from_date, bucket.to_date),
      })),
    skipped_locked_months: [...skipped].sort().map((month) => {
      const entry = skippedByLock.get(month) || { month, from_date: `${month}-01`, to_date: `${month}-01` };
      return {
        ...entry,
        day_count: dayCount(entry.from_date, entry.to_date),
        // WHEN the month was locked, carried through so the caller can tell a
        // settled month from one that was locked while this very propagation
        // was already owed. `lockedAt[month]` is absent for a lock nobody
        // recorded a time for, and unknown is not treated as late.
        locked_at: (lockedAt || {})[month] || null,
      };
    }),
  };
}

/** Inclusive day count between two `YYYY-MM-DD` dates. */
function dayCount(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / 86400000) + 1);
}

/**
 * The whole propagation, for every employee the facts mention.
 *
 * @returns {{work: object[], skipped_locked: object[]}} one entry per
 *   (employee, month) to recalculate, and one per (employee, month) skipped
 *   because payroll has locked it.
 */
function propagationScope({ workShiftId, employees, today, cutover = V2_CUTOVER_DATE }) {
  const work = [];
  const skippedLocked = [];

  (employees || []).forEach((entry) => {
    const { buckets, skipped_locked_months } = propagationForEmployee({
      employee: entry.employee,
      assignments: entry.assignments,
      overrideDates: entry.override_dates,
      lockedMonths: entry.locked_months,
      lockedAt: entry.locked_at,
      workShiftId,
      today,
      cutover,
    });
    const employeeId = Number(entry.employee_id);
    buckets.forEach((bucket) => work.push({ employee_id: employeeId, ...bucket }));
    skipped_locked_months.forEach((entry) =>
      skippedLocked.push({ employee_id: employeeId, ...entry })
    );
  });

  return { work, skipped_locked: skippedLocked };
}

/**
 * DOES THIS SHIFT DECIDE THIS EMPLOYEE'S MONTH?
 *
 * The question payroll's Approve & Lock asks about a pending propagation:
 * would that shift's rule change have reached THIS employee in THIS month?
 * It is answered by the same `propagationForEmployee` the worker's scope
 * comes from - not by a second idea of "affected" - with no locked months
 * passed, because the month being asked about is precisely the one that is
 * NOT locked yet.
 *
 * @param {string} month `YYYY-MM`
 */
function governsEmployeeMonth({
  employee,
  assignments,
  overrideDates = [],
  workShiftId,
  month,
  today,
  cutover = V2_CUTOVER_DATE,
}) {
  // The day AFTER the month, as "today", so the scope - which ends the day
  // before today - reaches the month's last day.
  const nextMonthStart = monthAfter(month);
  const { buckets } = propagationForEmployee({
    employee,
    assignments,
    overrideDates,
    lockedMonths: [],
    workShiftId,
    // A month is asked about IN FULL, whether or not it has ended. Using
    // today would make the answer depend on when the approval happens to be
    // run - and this asks whether the shift GOVERNS the month, not which of
    // its days are closed yet.
    today: nextMonthStart > toDateOnly(today) ? nextMonthStart : toDateOnly(today),
    cutover,
  });
  return buckets.some((bucket) => bucket.month === month);
}

module.exports = {
  monthOf,
  monthAfter,
  startOfMonth,
  endOfMonth,
  addDaysUtc,
  dayCount,
  assignedIntervals,
  governsEmployeeMonth,
  propagationForEmployee,
  propagationScope,
};
