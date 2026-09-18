/**
 * THE EMPLOYEE'S EXTRA BREAK HOURS, AS MINUTES.
 *
 * ONE DEFINITION, READ BY EVERY CALLER. `new_employee.extra_break_hours` is
 * stored in HOURS with two decimals, because that is the unit the Employee
 * Master field is labelled in and the unit HR states it in (half an hour is
 * `0.50`). The attendance engine works in whole minutes and in nothing else,
 * so the conversion happens here, once, rather than in the calculation
 * usecase and again in the dashboard - the two copies of the break-override
 * reader are exactly the drift this file exists to avoid.
 *
 * NULL AND 0 BOTH MEAN "NOTHING EXTRA", and unlike the Special Break
 * Duration Override the difference carries no meaning: the override's 0 is
 * the real setting "charge this employee no break at all", while an extra
 * break of zero is simply no extra break. Both therefore come back as 0 and
 * the engine adds nothing.
 *
 * A negative or unparseable value is 0 as well. This never SHORTENS somebody's
 * permitted break: a stored negative would be corrupt data, and quietly
 * turning it into a deduction would take minutes off an employee that no
 * human ever asked to take.
 */

/** Hours, rounded to the nearest whole minute. Never negative, never NaN. */
function extraBreakMinutes(row) {
  if (!row) return 0;
  const value = row.extra_break_hours;
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.round(hours * 60);
}

/**
 * The largest Extra Break Hours a human can mean.
 *
 * A break longer than a whole day is a typo, not a setting - the same bound
 * `setBreakOverride` puts on the override, said in hours.
 */
const MAX_EXTRA_BREAK_HOURS = 23.99;

/**
 * The stored value for what a human typed, or a reason it cannot be stored.
 *
 * Returns `{ ok: true, value }` with `value` either `null` (the field is
 * cleared, which is the same as no extra break) or a number rounded to the
 * column's two decimals. Blank, null and undefined all clear it; that is what
 * an emptied form field means, and it is not an error.
 */
function parseExtraBreakHours(input) {
  if (input === null || input === undefined || String(input).trim() === "") {
    return { ok: true, value: null };
  }
  const n = Number(input);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: "extra_break_hours must be a number of hours" };
  }
  if (n < 0) {
    return { ok: false, reason: "extra_break_hours cannot be negative" };
  }
  if (n > MAX_EXTRA_BREAK_HOURS) {
    return { ok: false, reason: "extra_break_hours must be less than a whole day" };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

module.exports = { extraBreakMinutes, parseExtraBreakHours, MAX_EXTRA_BREAK_HOURS };
