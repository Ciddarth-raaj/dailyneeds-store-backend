/**
 * ATTENDANCE CORRECTION COMES BEFORE SYSTEM OT.
 *
 * The attendance corrections that take priority over a date's system-raised
 * OT: while one is PENDING on the date, the OT is not raised from the
 * uncorrected day and an existing OT is not decided - the OT figure may
 * itself be wrong until attendance is corrected. The correction's final
 * decision re-runs the OT sync for the date.
 *
 * Shared by the repository (the guard under the row lock) and the usecase
 * (the early answer, the approval screen, Telegram), so every surface gives
 * the same answer.
 */
const CORRECTION_REQUEST_TYPES = Object.freeze(["REGULARIZATION", "REGULARIZATION_WITH_OT", "SHIFT_CHANGE", "PERMISSION"]);

const CORRECTION_PENDING_MESSAGE = "Attendance is being corrected. OT will be recalculated before approval.";

/** The status an approval screen shows for an OT waiting on a correction. */
const CORRECTION_PENDING_LABEL = "Waiting for attendance correction";

/** The one answer an OT decision gets while a correction is pending - DnDS, bulk and Telegram alike. */
function correctionPendingRefusal(blocker) {
  return {
    code: 409,
    waiting_for_correction: true,
    reason_code: "ATTENDANCE_CORRECTION_PENDING",
    blocking_request_id: blocker ? Number(blocker.attendance_approval_request_id) : null,
    blocking_request_type: blocker ? blocker.request_type : null,
    msg: CORRECTION_PENDING_MESSAGE,
  };
}

module.exports = { CORRECTION_REQUEST_TYPES, CORRECTION_PENDING_MESSAGE, CORRECTION_PENDING_LABEL, correctionPendingRefusal };
