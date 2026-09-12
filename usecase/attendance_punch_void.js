const { PUNCH_SOURCE } = require("../utils/attendance_engine");
const { toDateOnly } = require("../utils/shiftResolution");

/**
 * VOID PUNCH - exclude one raw BIOMAX / IMPORT punch from attendance
 * calculation, on the record, without touching the raw punch.
 *
 * The rules, all decided on the SERVER from the punch it reads:
 *
 *   - the punch must exist in `biomax_punch`; a REGULARIZED punch lives in a
 *     different table, cannot be named here, and is refused by source if a
 *     caller says that is what they meant;
 *   - it must be matched to an employee (an unmatched punch counts for
 *     nobody and there is nothing to exclude it from);
 *   - it must not already be voided;
 *   - the reason is mandatory and cannot be whitespace - the same five
 *     character minimum the regularization reason uses;
 *   - the attendance date the punch belongs to must carry NO PENDING
 *     regularization or OT request. Deciding a request re-reads the date's
 *     punches, and an approver must not find that the day changed under a
 *     request they are looking at; the request is decided or cancelled
 *     first. Approved and rejected history is never rewritten.
 *
 * The employee, the original time and the source come from the punch. The
 * actor comes from the session. Nothing about the punch is accepted from
 * the client but its id and, optionally, the source it believes it has.
 *
 * AFTER the void is stored the date is recalculated through the existing
 * single-employee/date path (`recalculateRange`), which is the same code the
 * Recalculate Attendance screen runs. The void and the recalculation are
 * NOT one transaction: the void is the audit record and must survive a
 * calculation failure, and the recalculation is idempotent and re-runnable.
 * If it fails the answer SAYS SO - `recalculated: false` with the error -
 * so the caller can run Recalculate Attendance for the date rather than
 * being told everything succeeded.
 */

const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  return err;
}

/** `biomax_punch.ingest_source` -> BIOMAX or IMPORT. */
function sourceOf(ingestSource) {
  return ingestSource === "DIGISME_IMPORT" || ingestSource === "IMPORT"
    ? PUNCH_SOURCE.IMPORT
    : PUNCH_SOURCE.BIOMAX;
}

const PENDING_REQUEST_MESSAGE =
  "This attendance date has a pending Attendance/OT request. Decide or cancel it before voiding a raw punch.";

module.exports = (punchVoidRepo, attendanceCalculationUsecase, attendanceRegularizationRepo) => {
  /**
   * @param {object} input
   * @param {number} input.biomax_punch_id
   * @param {string} input.reason
   * @param {string} [input.source]   what the caller believes the punch is;
   *        REGULARIZED is refused outright, BIOMAX/IMPORT must match the punch
   * @param {object} input.actor      `{ employee_id, user_id }` from the session
   */
  const voidPunch = async ({ biomax_punch_id, reason, source = null, actor = {} }) => {
    const punchId = Number(biomax_punch_id);
    if (!Number.isInteger(punchId) || punchId <= 0) {
      throw validationError("biomax_punch_id must be a raw punch id");
    }

    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed.length < MIN_REASON_LENGTH) {
      throw validationError(`A reason of at least ${MIN_REASON_LENGTH} characters is required`);
    }
    if (trimmed.length > MAX_REASON_LENGTH) {
      throw validationError(`The reason may be at most ${MAX_REASON_LENGTH} characters`);
    }

    const claimed = source ? String(source).toUpperCase() : null;
    if (claimed === PUNCH_SOURCE.REGULARIZED) {
      throw validationError(
        "A REGULARIZED punch cannot be voided here: it belongs to the approval workflow. Only raw BIOMAX / IMPORT punches can be voided."
      );
    }
    if (claimed !== null && claimed !== PUNCH_SOURCE.BIOMAX && claimed !== PUNCH_SOURCE.IMPORT) {
      throw validationError("source must be BIOMAX or IMPORT when given");
    }

    const punch = await punchVoidRepo.getRawPunchForVoid(punchId);
    if (!punch) throw notFoundError(`No raw punch exists for id ${punchId}`);

    const punchSource = sourceOf(punch.ingest_source);
    if (claimed !== null && claimed !== punchSource) {
      throw validationError(`Punch ${punchId} is a ${punchSource} punch, not ${claimed}`);
    }

    if (punch.attendance_punch_void_id) {
      throw validationError(
        `Punch ${punchId} is already voided (void #${punch.attendance_punch_void_id}, ${punch.voided_at || "date unknown"})`
      );
    }

    const employeeId =
      punch.employee_id === null || punch.employee_id === undefined ? null : Number(punch.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError(
        `Punch ${punchId} is not matched to an employee, so it counts for nobody and cannot be voided`
      );
    }

    // The attendance date the ENGINE gives the punch, under the historical
    // shift and cutoff - not what ingest wrote. That is the date whose stored
    // calculation the void changes, and the date whose pending requests
    // matter.
    const calendarDate = toDateOnly(punch.punch_date) || toDateOnly(punch.io_time);
    let attendanceDate = null;
    if (attendanceCalculationUsecase.attendanceDateForPunchTime) {
      attendanceDate = await attendanceCalculationUsecase.attendanceDateForPunchTime({
        employee_id: employeeId,
        punch_time: punch.io_time,
        near_date: calendarDate,
      });
    }
    if (!attendanceDate) attendanceDate = calendarDate;

    if (attendanceRegularizationRepo && attendanceRegularizationRepo.findOpenRequest) {
      const open = await attendanceRegularizationRepo.findOpenRequest(employeeId, attendanceDate);
      if (open) {
        const err = validationError(PENDING_REQUEST_MESSAGE);
        err.pending_request = {
          attendance_approval_request_id: open.attendance_approval_request_id,
          request_type: open.request_type,
          attendance_date: attendanceDate,
        };
        throw err;
      }
    }

    const inserted = await punchVoidRepo.insertVoid({
      biomax_punch_id: punchId,
      punch_source: punchSource,
      employee_id: employeeId,
      punch_io_time: punch.io_time,
      attendance_date: attendanceDate,
      reason: trimmed,
      voided_by_employee_id:
        actor.employee_id === undefined || actor.employee_id === null ? null : Number(actor.employee_id),
      voided_by_user_id: actor.user_id === undefined || actor.user_id === null ? null : Number(actor.user_id),
    });
    if (inserted.already_voided) {
      throw validationError(`Punch ${punchId} is already voided`);
    }

    const voidRecord = punchVoidRepo.getVoid
      ? await punchVoidRepo.getVoid(inserted.attendance_punch_void_id)
      : null;

    // The existing single employee/date recalculation. Its failure is
    // reported, never hidden: the void is already on the record and the
    // Recalculate Attendance screen can repair the date.
    let recalculated = false;
    let recalculationError = null;
    let day = null;
    try {
      const result = await attendanceCalculationUsecase.recalculateRange({
        employee_id: employeeId,
        from_date: attendanceDate,
        to_date: attendanceDate,
      });
      recalculated = true;
      day = result && Array.isArray(result.days) ? result.days[0] || null : null;
    } catch (err) {
      recalculationError = err && err.message ? err.message : String(err);
    }

    return {
      code: 200,
      attendance_punch_void_id: inserted.attendance_punch_void_id,
      biomax_punch_id: punchId,
      employee_id: employeeId,
      employee_name: punch.employee_name || null,
      punch_source: punchSource,
      punch_io_time: punch.io_time,
      attendance_date: attendanceDate,
      reason: trimmed,
      voided_by_employee_id: voidRecord ? voidRecord.voided_by_employee_id : null,
      voided_by_name: voidRecord ? voidRecord.voided_by_name || null : null,
      voided_at: voidRecord ? voidRecord.voided_at : null,
      recalculated,
      recalculation_error: recalculationError,
      day,
      msg: recalculated
        ? `Punch voided and ${attendanceDate} recalculated`
        : `Punch voided, but ${attendanceDate} could NOT be recalculated: ${recalculationError}. Run Recalculate Attendance for this employee and date.`,
    };
  };

  return { voidPunch, PENDING_REQUEST_MESSAGE, MIN_REASON_LENGTH };
};

module.exports.PENDING_REQUEST_MESSAGE = PENDING_REQUEST_MESSAGE;
module.exports.MIN_REASON_LENGTH = MIN_REASON_LENGTH;
module.exports.sourceOf = sourceOf;
