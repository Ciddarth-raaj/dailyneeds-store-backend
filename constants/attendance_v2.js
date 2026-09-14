/**
 * Attendance v2 constants shared by the application and by the migrations.
 *
 * THE CUTOVER. 2026-09-01 is the earliest attendance date v2 knows about: the
 * date the A0 shift-assignment history was seeded at, the date every work
 * shift's first configuration version is effective from, and the date the
 * Biomax device assignments were seeded with. Nothing before it is
 * calculated, and no dated history is ever invented earlier than it.
 *
 * It lives here rather than being retyped because the application now writes
 * assignment history too (Add Employee appends one), and a second copy of the
 * date in a second file is how the application and the migration end up
 * disagreeing about where v2 begins.
 */
const V2_CUTOVER_DATE = "2026-09-01";

/**
 * An assignment's effective date, never earlier than the cutover.
 *
 * `YYYY-MM-DD` string compare is date compare, which is why this is a
 * comparison and not date arithmetic. An unparseable or absent date falls
 * back to the cutover rather than to today: "we do not know when" is not
 * "now", and dating it now would leave the employee's earlier dates
 * unresolved for no reason.
 */
function effectiveFromNotBeforeCutover(dateOnly) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(dateOnly || "").trim());
  if (!m) return V2_CUTOVER_DATE;
  return m[1] > V2_CUTOVER_DATE ? m[1] : V2_CUTOVER_DATE;
}

module.exports = { V2_CUTOVER_DATE, effectiveFromNotBeforeCutover };
