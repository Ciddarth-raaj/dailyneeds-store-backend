/**
 * M2 — the salary period lock, as a CONTRACT.
 *
 * WHAT THIS IS FOR. Once monthly payroll exists, a period that has been
 * processed and paid must stop accepting changes to the salaries it was
 * computed from: back-dating a revision into a locked month silently
 * invalidates payslips that have already gone out and statutory returns that
 * have already been filed. The place that rule has to be enforced is the
 * salary write path, and that path is being built now.
 *
 * WHY IT ANSWERS "UNLOCKED" TODAY. Monthly payroll is M4/M5 and does not
 * exist; there are no periods, so no period can be locked. Returning a
 * permissive answer from a real interface is the honest version of "not built
 * yet" - and it means the call site, the shape of the answer and the tests
 * around it are all in place and exercised, so the later change is one
 * implementation swapped behind a stable signature rather than a new concept
 * threaded through the salary usecase after the fact.
 *
 * IT IS DELIBERATELY NOT A STUB THAT RETURNS `true`. `checkLock` returns a
 * reasoned object, and callers must read `.locked` - so when the real
 * implementation starts returning locked periods, every existing caller
 * already handles it.
 *
 * NOTHING HERE TOUCHES THE DATABASE. It takes no connection, because there is
 * no period table to read. When there is, this module gains one.
 */

/** Why a period is or is not locked. Stable strings; screens key off them. */
const LOCK_REASON = {
  PAYROLL_NOT_IMPLEMENTED: "PAYROLL_NOT_IMPLEMENTED",
  PERIOD_LOCKED: "PERIOD_LOCKED",
  PERIOD_OPEN: "PERIOD_OPEN",
};

/**
 * Is the salary period containing `effectiveFrom` locked against changes?
 *
 * @param {string} effectiveFrom  `YYYY-MM-DD`, the date a change would apply from
 * @returns {{locked: boolean, reason: string, period: string|null, message: string}}
 */
function checkLock(effectiveFrom) {
  const period = periodOf(effectiveFrom);
  return {
    locked: false,
    reason: LOCK_REASON.PAYROLL_NOT_IMPLEMENTED,
    period,
    message:
      "Monthly payroll is not implemented, so no salary period is locked. " +
      "This check exists so that the rule has a place to live when it is.",
  };
}

/**
 * The period a date falls in, as `YYYY-MM`.
 *
 * Monthly, because Daily Needs pays monthly. It is computed from the string
 * rather than through a Date so that a timezone can never move a payroll month
 * - the 1st of a month parsed as UTC and read back locally is a real way to
 * land in the previous period.
 */
function periodOf(effectiveFrom) {
  if (!effectiveFrom) return null;
  const m = String(effectiveFrom).match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * Throw-shaped helper for the write paths: returns an error message when a
 * change may not be made, or null when it may.
 */
function blockedReason(effectiveFrom) {
  const lock = checkLock(effectiveFrom);
  if (!lock.locked) return null;
  return `The salary period ${lock.period} is locked and cannot accept changes`;
}

module.exports = { LOCK_REASON, checkLock, periodOf, blockedReason };
