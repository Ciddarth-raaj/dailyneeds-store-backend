const { JOINED_ON } = require("./joining_date");

/**
 * `utils/attendance_eligibility.js#eligibleOn`, EXPRESSED AS SQL.
 *
 * The JS helper is the rule. This is the same rule for the cases where the
 * population has to be narrowed in the database rather than filtered in
 * memory - a dashboard counting thousands of employees cannot load them all
 * to ask a predicate about each one. Every clause below maps to one line of
 * that helper, and the mapping is written out so the two cannot drift
 * silently:
 *
 *   attendanceRequired(row)          COALESCE(attendance_required, 1) = 1
 *                                    COALESCE, because the helper reads an
 *                                    ABSENT value as REQUIRED: the column is
 *                                    NOT NULL DEFAULT 1 and "not asked for"
 *                                    must never silently exempt anybody.
 *
 *   on < joiningDateOf(employee)     (JOINED_ON IS NULL OR JOINED_ON <= today)
 *     excludes                       An unreadable or absent joining date is
 *                                    UNBOUNDED on that side in the helper, so
 *                                    it is INCLUDED here - 425 of 630
 *                                    production rows carry no readable date
 *                                    and excluding them would empty the page
 *                                    rather than correct it.
 *
 *   on > resignationDateOf(employee) (resignation_date IS NULL OR
 *     excludes                        resignation_date >= today)
 *
 * `status` IS NOT CONSULTED, deliberately and to match the helper, which
 * says so at length: `new_employee.status` is maintained by hand and has been
 * left at 1 for most leavers, so reading it would put people who left years
 * ago back into today's population - and, read the other way, would drop
 * somebody whose status was never set but who has no resignation date and is
 * still here. Only the dated facts decide.
 *
 * `date_of_joining` is a VARCHAR holding three different shapes, so it goes
 * through `JOINED_ON` - the one shared parser the lifecycle backfill, payroll
 * and the attendance dashboard already use - rather than being compared as
 * text.
 *
 * `employee_employment_period` is NOT consulted, for the reason
 * `repository/attendance_calculation.js` records: its backfill still carries
 * rows flagged needs_review, so this reads the columns payroll reads. A
 * resign-then-rejoin GAP is therefore not modelled, exactly as in the helper.
 *
 * @param {string} t   table alias, e.g. "ne"
 * @returns {{clause: string, paramCount: number}} `paramCount` placeholders,
 *          each of which must be bound to the SAME business date.
 */
function currentlyAttendanceEligible(t = "ne") {
  return {
    clause: `(COALESCE(${t}.attendance_required, 1) = 1
              AND (${t}.resignation_date IS NULL OR ${t}.resignation_date >= ?)
              AND ((${JOINED_ON(t)}) IS NULL OR (${JOINED_ON(t)}) <= ?))`,
    paramCount: 2,
  };
}

/** The bound values for the clause above: one business date per placeholder. */
function currentlyAttendanceEligibleParams(today) {
  return [today, today];
}

module.exports = { currentlyAttendanceEligible, currentlyAttendanceEligibleParams };
