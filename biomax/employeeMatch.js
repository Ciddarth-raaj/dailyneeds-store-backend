/**
 * Biomax `user_id` -> `new_employee.employee_id` (D4, R5).
 *
 * The device sends the employee code as a string; the employee master keys
 * on an INT. Matching is numeric-lenient - "0042" is employee 42 - but
 * strict about what counts as a number:
 *
 *   1 to 9 ASCII digits, and nothing else, with an integer value > 0.
 *
 * So "0", "000", "", "A123", "12 " (trailing space), "1e3", "-5", "1.0",
 * full-width digits and anything ten digits or longer all yield null and the
 * punch is UNMATCHED. In particular nothing here can ever produce 0, so an
 * accidental employee row with id 0 cannot be matched; the store's lookup
 * also filters `employee_id > 0` for the same reason.
 *
 * Pure. The raw `user_id` is always stored verbatim beside whatever this
 * returns; this function decides the join key only.
 */

const CODE_RE = /^[0-9]{1,9}$/;

/**
 * @param {unknown} userId the JSON user_id as parsed (a string)
 * @returns {number|null} the employee_id candidate, or null
 */
function parseEmployeeCode(userId) {
  if (typeof userId !== "string") return null;
  if (!CODE_RE.test(userId)) return null;
  const n = Number(userId);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

module.exports = { parseEmployeeCode };
