/**
 * HISTORICAL OT REVIEW - THE RULE. Pure: no database, no clock.
 *
 * Attendance dates before the automatic-OT cutover carry calculated OT that
 * nothing ever sent for approval (the automation is forbidden to raise OT
 * before its cutover, and the deploy backfill only reached each employee's
 * previous five attendance days). This rule decides, for one stored day with
 * calculated OT, what a Historical OT Review would do with it - and the
 * preview, the read-only impact report and the authorised apply all call it,
 * so what an administrator saw is what is applied.
 *
 * WHAT IT NEVER PROPOSES: approving anything, paying anything, touching a
 * locked or published payroll row, or a second request for a date that has
 * (or had) one. The only action is CREATE a PENDING OT request, which the
 * employee's ordinary approval chain then decides. In a locked month an
 * approval settles forward as Prior-Month OT through the existing
 * `attendance_ot_late_settlement` path.
 */
const crypto = require("crypto");

/** The window the review may act on: from here to the day before the cutover. */
const HISTORICAL_REVIEW_FROM = "2026-09-01";

const PAYROLL_STATUS = Object.freeze({
  NOT_CALCULATED: "NOT_CALCULATED",
  CALCULATED: "CALCULATED",
  APPROVED_LOCKED: "APPROVED_LOCKED",
  PUBLISHED: "PUBLISHED",
});

const ACTION = Object.freeze({
  /** Unlocked payroll: a Pending OT request; approval pays it in its own month. */
  CREATE_PENDING_OT: "CREATE_PENDING_OT",
  /** Locked/published payroll: a Pending OT request; approval settles as Prior-Month OT. */
  CREATE_PENDING_OT_PRIOR_MONTH: "CREATE_PENDING_OT_PRIOR_MONTH_SETTLEMENT",
  SKIP_EXISTING_PENDING: "SKIP_EXISTING_PENDING",
  SKIP_EXISTING_APPROVED: "SKIP_EXISTING_APPROVED",
  SKIP_EXISTING_REJECTED: "SKIP_EXISTING_REJECTED",
  SKIP_CLOSED_AT_PAYROLL_LOCK: "SKIP_CLOSED_AT_PAYROLL_LOCK",
  SKIP_ALREADY_PAID: "SKIP_ALREADY_PAID",
  SKIP_ALREADY_REVIEWED: "SKIP_ALREADY_REVIEWED",
  /*
   * A CANCELLED OT request on the date is never re-opened by a review. The
   * system withdrew it (the eligible OT went away, or the attendance became
   * incomplete - that case has its own deferred re-evaluation), or an
   * administrator revoked a decision. Either way somebody or something
   * decided against it; a bulk review is not the place to undo that. Listed,
   * with how it was cancelled, for a person to look at.
   */
  SKIP_PREVIOUSLY_WITHDRAWN: "SKIP_PREVIOUSLY_WITHDRAWN",
  SKIP_PREVIOUSLY_REVOKED: "SKIP_PREVIOUSLY_REVOKED",
  SKIP_ATTENDANCE_INCOMPLETE: "SKIP_ATTENDANCE_INCOMPLETE",
  SKIP_CORRECTION_PENDING: "SKIP_CORRECTION_PENDING",
  SKIP_OUTSIDE_EMPLOYMENT: "SKIP_OUTSIDE_EMPLOYMENT",
  SKIP_ON_OR_AFTER_CUTOVER: "SKIP_ON_OR_AFTER_CUTOVER",
});
const CREATE_ACTIONS = Object.freeze([ACTION.CREATE_PENDING_OT, ACTION.CREATE_PENDING_OT_PRIOR_MONTH]);

const int0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};
const dateOnly = (v) => (v === null || v === undefined ? null : String(v).slice(0, 10));

/** The payroll status of the date's month for the employee. */
function payrollStatusOf(row) {
  if (!row.payroll_status) return PAYROLL_STATUS.NOT_CALCULATED;
  if (row.payroll_status === "APPROVED_LOCKED") {
    return row.payroll_published_at ? PAYROLL_STATUS.PUBLISHED : PAYROLL_STATUS.APPROVED_LOCKED;
  }
  return PAYROLL_STATUS.CALCULATED;
}

/**
 * ONE DAY, CLASSIFIED. `row` is what `listCandidates` reads; `cutover` is the
 * automatic-OT cutover date. Returns the preview line.
 */
function classify(row, { cutover }) {
  const date = dateOnly(row.attendance_date);
  const calculated = Math.max(0, int0(row.candidate_ot_minutes) - int0(row.shift_authorised_ot_minutes));
  const payroll = payrollStatusOf(row);
  const locked = payroll === PAYROLL_STATUS.APPROVED_LOCKED || payroll === PAYROLL_STATUS.PUBLISHED;
  const line = {
    employee_id: Number(row.employee_id),
    employee_name: row.employee_name || null,
    attendance_date: date,
    calculated_ot_minutes: calculated,
    existing_request_id: row.ot_request_id === null || row.ot_request_id === undefined ? null : Number(row.ot_request_id),
    existing_status: row.ot_request_status || null,
    withdrawn_request_id:
      row.withdrawn_request_id === null || row.withdrawn_request_id === undefined ? null : Number(row.withdrawn_request_id),
    withdrawn_kind: row.withdrawn_request_id === null || row.withdrawn_request_id === undefined ? null : row.withdrawn_kind || "CANCELLED",
    late_settlement_status: row.late_settlement_status || null,
    deferred_marker: row.marker_status ? `${row.marker_status}:${row.marker_source}` : null,
    payroll_status: payroll,
    payroll_calculation_id:
      row.payroll_calculation_id === null || row.payroll_calculation_id === undefined ? null : Number(row.payroll_calculation_id),
    proposed_action: null,
  };
  const act = (action) => ({ ...line, proposed_action: action });

  if (cutover && date >= cutover) return act(ACTION.SKIP_ON_OR_AFTER_CUTOVER);
  // An existing decision or open request is never duplicated.
  if (line.existing_status === "PENDING") return act(ACTION.SKIP_EXISTING_PENDING);
  if (line.existing_status === "APPROVED") return act(ACTION.SKIP_EXISTING_APPROVED);
  if (line.existing_status === "REJECTED") {
    return act(row.ot_request_closure_reason ? ACTION.SKIP_CLOSED_AT_PAYROLL_LOCK : ACTION.SKIP_EXISTING_REJECTED);
  }
  // Anything already paid or on its way to being paid.
  if (line.late_settlement_status || int0(row.approved_ot_minutes) > 0) return act(ACTION.SKIP_ALREADY_PAID);
  // Never twice: a date a review already raised OT on, whatever became of it.
  if (Number(row.already_reviewed) === 1) return act(ACTION.SKIP_ALREADY_REVIEWED);
  // Never re-open a cancelled request (see SKIP_PREVIOUSLY_WITHDRAWN).
  if (line.withdrawn_request_id !== null) {
    return act(line.withdrawn_kind === "REVOKED" ? ACTION.SKIP_PREVIOUSLY_REVOKED : ACTION.SKIP_PREVIOUSLY_WITHDRAWN);
  }
  if (Number(row.outside_employment) === 1) return act(ACTION.SKIP_OUTSIDE_EMPLOYMENT);
  // Attendance comes first: no OT from an unsettled or uncorrected day.
  if (Number(row.is_final) !== 1 || row.status !== "FINAL" || int0(row.punch_count) % 2 === 1) {
    return act(ACTION.SKIP_ATTENDANCE_INCOMPLETE);
  }
  if (Number(row.correction_pending) === 1) return act(ACTION.SKIP_CORRECTION_PENDING);
  return act(locked ? ACTION.CREATE_PENDING_OT_PRIOR_MONTH : ACTION.CREATE_PENDING_OT);
}

/** The lines a preview reports: only days whose calculated OT is above zero. */
function buildPreview(rows, { cutover }) {
  return (rows || []).map((r) => classify(r, { cutover })).filter((l) => l.calculated_ot_minutes > 0);
}

/**
 * THE FINGERPRINT OF WHAT WAS AUTHORISED: every line's employee, date,
 * minutes, payroll status and proposed action, sorted. An authorisation is
 * refused if the preview it names no longer matches the database.
 */
function previewHash(lines) {
  const text = (lines || [])
    .map((l) => `${l.employee_id}|${l.attendance_date}|${l.calculated_ot_minutes}|${l.payroll_status}|${l.proposed_action}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Totals: overall, by proposed action and by payroll status. */
function summarize(lines) {
  const bucket = () => ({ entries: 0, minutes: 0, employees: new Set() });
  const add = (b, l) => {
    b.entries += 1;
    b.minutes += l.calculated_ot_minutes;
    b.employees.add(l.employee_id);
  };
  const all = bucket();
  const byAction = {};
  const byPayroll = {};
  const withoutRequest = bucket();
  (lines || []).forEach((l) => {
    add(all, l);
    add((byAction[l.proposed_action] = byAction[l.proposed_action] || bucket()), l);
    add((byPayroll[l.payroll_status] = byPayroll[l.payroll_status] || bucket()), l);
    if (!l.existing_status) add(withoutRequest, l);
  });
  const flat = (b) => ({ entries: b.entries, minutes: b.minutes, employees: b.employees.size });
  const map = (o) => Object.fromEntries(Object.entries(o).sort().map(([k, v]) => [k, flat(v)]));
  const creatable = (lines || []).filter((l) => CREATE_ACTIONS.includes(l.proposed_action));
  return {
    calculated_ot: flat(all),
    without_request: flat(withoutRequest),
    to_create: flat(creatable.reduce((b, l) => (add(b, l), b), bucket())),
    by_proposed_action: map(byAction),
    by_payroll_status: map(byPayroll),
  };
}

module.exports = {
  HISTORICAL_REVIEW_FROM,
  PAYROLL_STATUS,
  ACTION,
  CREATE_ACTIONS,
  classify,
  buildPreview,
  previewHash,
  summarize,
  payrollStatusOf,
};
