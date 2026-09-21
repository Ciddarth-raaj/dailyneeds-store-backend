/**
 * THE HR SHIFT CHANGE BLOCK - an ADDITIONAL gate, never a replacement.
 *
 * ================================ WHAT THIS IS, AND WHAT IT IS NOT =========
 *
 * `utils/shift_change_eligibility.js` answers the SYSTEM question: does the
 * roster, the calendar, the payroll lock and the request table permit a shift
 * change for this employee on this date? That rule is untouched by this file
 * and must stay that way - nothing here changes an NRM comparison, a
 * backdating window, a payroll lock or the one-open-request key.
 *
 * This file answers a SECOND, HUMAN question that sits beside it: has HR
 * decided that this particular employee/date must not be regularised anyway,
 * whatever the system thinks? A punch that was mis-scanned, a day worked
 * outside the shift without authorisation - the arithmetic cannot see those,
 * and a person has to say so.
 *
 *     SYSTEM ELIGIBLE  AND  NOT HR BLOCKED  AND  request state permits
 *     =  the employee may submit
 *
 * The three are kept apart deliberately. A blocked row still reports its real
 * system verdict and its real request status; the report shows all three
 * columns and never overwrites one with another, because "the system would
 * have allowed this, but HR said no" is exactly the fact HR needs to see.
 *
 * ================================== A BLOCK IS NOT A REJECTION =============
 *
 * There may be no request to reject - that is the whole point. HR blocks a
 * DATE so a request is never raised, and the vocabulary stays honest about it:
 * "Blocked by HR", never "Rejected". Where a request DOES exist and is
 * pending, this feature stands aside entirely: the approval chain is the
 * authority there, and `canCreateBlock` below refuses.
 *
 * ================================== PURE, LIKE THE RULE IT SITS BESIDE =====
 *
 * No database, no clock, no Express. The caller loads the active block (one
 * read for one request, one bulk read for the whole report) and hands it over.
 * That is what lets the employee path, the options path and the report share
 * one decision while reading it in whatever shape suits them.
 */

/** The reason codes this gate produces. Distinct from the system rule's. */
const BLOCK_REASON = Object.freeze({
  HR_BLOCKED: "HR_BLOCKED",
});

/** Why a block may NOT be created. Each maps to a sentence a person reads. */
const BLOCK_REFUSAL = Object.freeze({
  REQUEST_PENDING: "REQUEST_PENDING",
  REQUEST_APPROVED: "REQUEST_APPROVED",
  SYSTEM_INELIGIBLE: "SYSTEM_INELIGIBLE",
  ALREADY_BLOCKED: "ALREADY_BLOCKED",
});

/** The request states this gate reasons about, spelled as the report spells them. */
const REQUEST_STATE = Object.freeze({
  NOT_RAISED: "NOT_RAISED",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

/** `2026-09-21` -> `21/09/2026`. What a person in India reads on a screen. */
function displayDate(dateOnly) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(dateOnly || "");
}

/**
 * THE SENTENCE THE EMPLOYEE IS SHOWN, wherever they meet the block - the web
 * form, a direct API call, or the Telegram Mini App.
 *
 * It names the date and quotes HR's own reason, because "not allowed" without
 * a reason is what makes somebody ask their manager, who asks HR, who looks it
 * up. One copy, so all three surfaces say the same thing.
 */
function blockMessage({ attendance_date, reason }) {
  const because = String(reason || "").trim();
  return (
    `Shift change request is not allowed for ${displayDate(attendance_date)}. ` +
    `HR marked this date as not eligible${because ? `: ${because}` : "."}` +
    (because && !/[.!?]$/.test(because) ? "." : "")
  );
}

/** Is this row an ACTIVE block? A removed one is history, never a gate. */
function isActive(block) {
  return !!block && !block.removed_at;
}

/**
 * ===================== THE EFFECTIVE VERDICT. THE ONLY ONE. ===============
 *
 * Composes the system verdict with the HR block WITHOUT recomputing either.
 * `system` is whatever `shift_change_eligibility.decide` returned; this
 * function never second-guesses it and never makes an ineligible date
 * eligible - a block can only ever subtract.
 *
 * WHY THE SYSTEM VERDICT STILL WINS ITS OWN REFUSALS. A payroll-locked date
 * that is also blocked reports the payroll lock: it is the more fundamental
 * and more permanent fact, HR cannot act on the block to change it, and
 * telling them "HR blocked this" would hide the reason the date is actually
 * closed. The block only ever speaks when the system would otherwise have
 * said yes.
 */
function effectiveVerdict({ system, active_block = null, attendance_date = null }) {
  const blocked = isActive(active_block);
  const base = system || { can_raise: false, reason_code: null, reason: "" };

  if (!blocked) {
    return {
      can_raise: !!base.can_raise,
      reason_code: base.reason_code,
      reason: base.reason,
      hr_blocked: false,
      system_can_raise: !!base.can_raise,
    };
  }

  // Blocked, but the system already refuses for its own reason: report that.
  if (!base.can_raise) {
    return {
      can_raise: false,
      reason_code: base.reason_code,
      reason: base.reason,
      hr_blocked: true,
      system_can_raise: false,
    };
  }

  return {
    can_raise: false,
    reason_code: BLOCK_REASON.HR_BLOCKED,
    reason: blockMessage({
      attendance_date: attendance_date || active_block.attendance_date,
      reason: active_block.reason,
    }),
    hr_blocked: true,
    system_can_raise: true,
  };
}

/**
 * ===================== MAY HR CREATE A BLOCK HERE? ========================
 *
 * The write-side rule, kept next to the read-side one so the button, the API
 * and the usecase cannot disagree about when blocking is meaningful.
 *
 * NOT RAISED    yes, when the system currently permits a request - that is
 *               the ordinary case, stopping one before it is raised.
 * REJECTED      yes, on the same condition. A rejection does NOT close the
 *               date in production (`shift_change_eligibility.js` lets a
 *               rejected date be re-raised), so without this HR could reject a
 *               request and watch the same one arrive again. Blocking here
 *               touches nothing about the rejected request: it stays REJECTED,
 *               with its own decision and reason intact.
 * PENDING       no. There IS a request, and the approval chain is its
 *               authority - rejecting it there is the correct action, and a
 *               pre-request block would be a second, quieter way to decide the
 *               same thing.
 * APPROVED      no. The date is settled in the employee's favour; a block
 *               would neither undo it nor mean anything.
 *
 * AND NEVER WHEN THE SYSTEM ALREADY REFUSES. A payroll-locked date, one
 * outside the backdating window, one with no longer shift available - the
 * production rule already permanently refuses these, and writing a block row
 * for them would be a record that changes nothing, ages badly, and invites
 * somebody to believe removing it would reopen the date.
 */
function canCreateBlock({ system_can_raise, request_state, active_block = null }) {
  const refuse = (code, message) => ({ allowed: false, refusal_code: code, refusal: message });

  if (isActive(active_block)) {
    return refuse(
      BLOCK_REFUSAL.ALREADY_BLOCKED,
      "This employee and date are already blocked by HR."
    );
  }
  if (request_state === REQUEST_STATE.PENDING) {
    return refuse(
      BLOCK_REFUSAL.REQUEST_PENDING,
      "A shift change request for this date is already pending. Reject it through the approval flow instead of blocking the date."
    );
  }
  if (request_state === REQUEST_STATE.APPROVED) {
    return refuse(
      BLOCK_REFUSAL.REQUEST_APPROVED,
      "A shift change request for this date has already been approved and cannot be blocked."
    );
  }
  if (!system_can_raise) {
    return refuse(
      BLOCK_REFUSAL.SYSTEM_INELIGIBLE,
      "A shift change request for this date is already not possible, so there is nothing to block."
    );
  }
  return { allowed: true, refusal_code: null, refusal: null };
}

/** The report's word for the HR column. Never mixed with the request status. */
const HR_ELIGIBILITY = Object.freeze({
  ALLOWED: "Allowed",
  BLOCKED: "Blocked by HR",
});

/** The filter vocabulary the screen, the export and the API share. */
const HR_ELIGIBILITY_FILTER = Object.freeze(["ALL", "ALLOWED", "BLOCKED"]);

/** `employee:date`, the key both the report and the write path index blocks by. */
function blockKey(employeeId, attendanceDate) {
  return `${Number(employeeId)}:${attendanceDate}`;
}

module.exports = {
  BLOCK_REASON,
  BLOCK_REFUSAL,
  REQUEST_STATE,
  HR_ELIGIBILITY,
  HR_ELIGIBILITY_FILTER,
  displayDate,
  blockMessage,
  isActive,
  effectiveVerdict,
  canCreateBlock,
  blockKey,
};
