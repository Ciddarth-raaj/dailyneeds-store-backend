/**
 * WHY A DAY'S CALCULATED OT HAS (OR HAS NOT) BEEN SENT FOR APPROVAL.
 *
 * One pure rule, used in two places so they can never disagree:
 *
 *   `usecase/attendance_regularization.js#syncAutoOt` - which DATES the
 *       automation may raise an OT request on (`autoOtCreationGate`);
 *   the attendance READ (`usecase/attendance_calculation.js#readRange`) -
 *       which tells an employee or an administrator, beside "OT Calculated",
 *       whether that OT is on its way to approval or will NOT be raised, and
 *       why (`explainAutoOt`).
 *
 * Before this existed the read said "goes to approval automatically" for
 * every calculated OT with no request - including OT dated before the
 * automatic-OT cutover, which the sync is deliberately forbidden to raise.
 * Such OT then sat on the attendance screen as if in transit, and never
 * appeared in OT Approvals.
 *
 * NOTHING HERE WRITES OR RAISES ANYTHING. It explains; it never backfills.
 */

const AUTO_OT_GATE = Object.freeze({
  /** Automatic OT is not installed, or switched off (the kill switch). */
  AUTOMATION_OFF: "AUTOMATION_OFF",
  /** Dated before `attendance_ot_auto_pending_setting.auto_pending_from_date`. */
  BEFORE_CUTOVER: "BEFORE_CUTOVER",
  /** Older than the request backdate window. */
  OUTSIDE_WINDOW: "OUTSIDE_WINDOW",
  /** The month's payroll is Approved & Locked for this employee. */
  PAYROLL_LOCKED: "PAYROLL_LOCKED",
});

/** What the read reports for calculated OT that has no request. */
const AUTO_OT_STATE = Object.freeze({
  /** Within every rule: the automation raises it on its next run for the date. */
  AWAITING_AUTOMATIC_REQUEST: "AWAITING_AUTOMATIC_REQUEST",
  /** A rule keeps the automation from ever raising it on its own. */
  NOT_RAISED: "NOT_RAISED",
});

const dateOnly = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

/**
 * THE DATE GATES for creating an automatic OT request, exactly as the sync
 * applies them: a remembered (deferred) date passes; otherwise a date before
 * the cutover - or before the deploy backfill's own `creation_from`, when that
 * is earlier - is BEFORE_CUTOVER, and one older than the backdate window
 * (unless the backfill covers it) is OUTSIDE_WINDOW. Null means "may raise".
 */
function autoOtCreationGate({ date, cutover, creation_from = null, oldest, marker_waiting = false }) {
  const d = dateOnly(date);
  const cut = dateOnly(cutover);
  const from = dateOnly(creation_from);
  const floor = dateOnly(oldest);
  if (marker_waiting) return null;
  const effectiveCutover = cut && from && from < cut ? from : cut;
  if (effectiveCutover && d < effectiveCutover) return AUTO_OT_GATE.BEFORE_CUTOVER;
  if (floor && d < floor && !(from && d >= from)) return AUTO_OT_GATE.OUTSIDE_WINDOW;
  return null;
}

/** "7 Oct 2026" - how the explanation names a date. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function displayDate(date) {
  const d = dateOnly(date);
  if (!d) return null;
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

const DETAIL = {
  [AUTO_OT_GATE.AUTOMATION_OFF]: () => "Not sent for approval: automatic OT approval is switched off",
  [AUTO_OT_GATE.BEFORE_CUTOVER]: (cutover) =>
    `Not sent for approval: dated before automatic OT approval started (${displayDate(cutover)})`,
  [AUTO_OT_GATE.OUTSIDE_WINDOW]: (cutover, days) =>
    `Not sent for approval: older than the ${days}-day approval window`,
  [AUTO_OT_GATE.PAYROLL_LOCKED]: () => "Not sent for approval: payroll for this month is locked",
};

/**
 * THE EXPLANATION for one day whose calculated OT has no request.
 *
 * @returns {{state:string, reason:string|null, cutover_date:string|null, detail:string}}
 */
function explainAutoOt({ date, setting, oldest, max_backdate_days, marker_waiting = false, locked = false }) {
  const cutover = setting ? dateOnly(setting.auto_pending_from_date) : null;
  const enabled = !!setting && Number(setting.enabled) === 1 && !!cutover;
  const notRaised = (reason) => ({
    state: AUTO_OT_STATE.NOT_RAISED,
    reason,
    cutover_date: cutover,
    detail: DETAIL[reason](cutover, max_backdate_days),
  });
  if (!enabled) return notRaised(AUTO_OT_GATE.AUTOMATION_OFF);
  // The lock first: a locked month takes no new OT whatever its date.
  if (locked) return notRaised(AUTO_OT_GATE.PAYROLL_LOCKED);
  const gate = autoOtCreationGate({ date, cutover, oldest, marker_waiting });
  if (gate) return notRaised(gate);
  return {
    state: AUTO_OT_STATE.AWAITING_AUTOMATIC_REQUEST,
    reason: null,
    cutover_date: cutover,
    detail: "Sent for approval automatically - no request needed",
  };
}

module.exports = { AUTO_OT_GATE, AUTO_OT_STATE, autoOtCreationGate, explainAutoOt, displayDate };
