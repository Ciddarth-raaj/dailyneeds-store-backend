/**
 * HR MARKS AN EMPLOYEE/DATE NOT ELIGIBLE - the write side of the block.
 *
 * ============================== WHAT IT REFUSES, AND WHY EACH ONE =========
 *
 * Every refusal below is decided by `utils/shift_change_block.js#canCreateBlock`,
 * the shared rule, over facts this file re-reads AT WRITE TIME:
 *
 *   PENDING request      the approval chain is the authority for a request
 *                        that exists; rejecting it there is the correct
 *                        action, and a pre-request block would be a second,
 *                        quieter way to decide the same thing.
 *   APPROVED request     the date is settled in the employee's favour.
 *   system ineligible    a payroll-locked date, one outside the backdating
 *                        window, one with no longer shift - production
 *                        already refuses these permanently, and a block row
 *                        for them would record nothing and mislead whoever
 *                        read it later.
 *   already blocked      including the case where somebody else blocked it a
 *                        millisecond ago; see CONCURRENCY below.
 *
 * REJECTED IS ALLOWED, and it is the case this feature exists for. A rejected
 * shift request does NOT close the date in production - the employee may
 * simply raise another - so without a block HR could reject a request and
 * watch the same one arrive the next morning. Blocking after a rejection
 * touches NOTHING about the rejected request: it keeps its status, its
 * decision, its reason and its audit trail, and this file has no statement
 * that could change any of them.
 *
 * ================== THE BROWSER'S ROW IS NEVER THE AUTHORITY ==============
 *
 * The report row HR clicked may be minutes old. A month may have closed since
 * it was drawn; somebody may have raised a request; another HR user may have
 * blocked the same row. So the usecase re-reads the live system verdict and
 * the live request state through `shiftChangeEligibilityFor` - the SAME gates
 * `raiseShiftChangeRequest` applies - and decides from those. Nothing from the
 * request body is trusted except the employee, the date and the reason.
 *
 * ============================== AUTHORIZATION =============================
 *
 * TWO SEPARATE QUESTIONS, both settled on the server:
 *
 *   MAY THIS PERSON BLOCK AT ALL?   `manage_shift_change_eligibility`, checked
 *                                   by the route's permission middleware. It
 *                                   is a WRITE key and deliberately not the
 *                                   report's read key.
 *   MAY THEY BLOCK THIS EMPLOYEE?   the employee's CURRENT `store_id`, re-read
 *                                   here from `new_employee`, tested against
 *                                   the actor's branch scope with the shared
 *                                   `isEmployeeInScope`.
 *
 * NO OUTLET OR STORE ID FROM THE BROWSER IS READ, ever. The block row stores
 * an `outlet_id` snapshot for audit, and that snapshot is never consulted for
 * authorization - a later transfer must not change who may act on the row.
 *
 * ============================== CONCURRENCY ===============================
 *
 * The pre-check below is a courtesy, not the guarantee. Two HR users on the
 * same row both pass it; the database's unique key over the generated
 * `active_block` column lets exactly ONE insert through, and the loser is
 * told "already blocked by HR" rather than being shown a duplicate-key error.
 * Removal is the same shape: the UPDATE carries `removed_at IS NULL`, so of
 * two simultaneous removals one matches a row and the other matches none, and
 * neither can overwrite the other's actor or reason.
 *
 * ============================== IT WRITES ONE TABLE =======================
 *
 * `attendance_shift_change_block`, and nothing else. No attendance row, no
 * punch, no shift assignment, no approval request and no payroll lock is
 * written by any path in this file - blocking a date changes what MAY happen
 * next, never what already did.
 */

const { toDateOnly } = require("../utils/shiftResolution");
const { isEmployeeInScope } = require("../utils/employee_branch_scope");
const shiftChangeBlock = require("../utils/shift_change_block");

/** A reason a person typed. Long enough to mean something, bounded by the column. */
const MIN_REASON = 5;
const MAX_REASON = 500;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

function forbiddenError(message) {
  const err = new Error(message);
  err.name = "ForbiddenError";
  err.code = 403;
  return err;
}

/** A mandatory free-text reason, trimmed and bounded. Never optional. */
function requireReason(value, what) {
  if (typeof value !== "string" || value.trim().length < MIN_REASON) {
    throw validationError(`A ${what} of at least ${MIN_REASON} characters is required`);
  }
  return value.trim().slice(0, MAX_REASON);
}

module.exports = (attendanceShiftChangeBlockRepo, attendanceRegularizationUsecase) => {
  /**
   * The employee as the SERVER knows them right now: who they are and which
   * branch they are in. Both facts come from `new_employee`, never from the
   * request body.
   */
  const resolveEmployee = async (employeeId) => {
    const row = await attendanceShiftChangeBlockRepo.getEmployeeForBlock(employeeId);
    if (!row) throw validationError(`No such employee: ${employeeId}`);
    return {
      employee_id: Number(row.employee_id),
      employee_name: row.employee_name || null,
      store_id: row.store_id === null || row.store_id === undefined ? null : Number(row.store_id),
      outlet_name: row.outlet_name || null,
    };
  };

  /**
   * THE BRANCH PRE-CHECK - a cheap, friendly refusal, and NOT the boundary.
   *
   * It reads the employee outside any transaction, so between it and the write
   * the employee can be transferred. The AUTHORITATIVE check is made by the
   * repository against the row read UNDER THE EMPLOYEE LOCK, in the same
   * transaction as the write (see
   * `repository/attendance_shift_change_block.js#lockedRowInScope`). This one
   * exists so the common case fails fast with a clear message rather than
   * after a transaction, and it can never grant anything the locked check
   * would refuse.
   */
  const authorizeBranch = (scope, employee) => {
    if (!isEmployeeInScope(scope, employee.store_id)) {
      throw forbiddenError(
        "You do not have access to this employee's branch."
      );
    }
  };

  /** The employee/date pair, validated the same way on every entry point. */
  const target = ({ employee_id, attendance_date }) => {
    const employeeId = Number(employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    return { employeeId, date };
  };

  /**
   * ============================ MARK NOT ELIGIBLE =========================
   *
   * Creates the block, after re-deciding from live facts that one is both
   * permitted and meaningful.
   */
  const blockDate = async ({
    actor,
    scope,
    employee_id,
    attendance_date,
    reason,
    today = null,
  }) => {
    const { employeeId, date } = target({ employee_id, attendance_date });
    const blockReason = requireReason(reason, "reason for blocking");

    const employee = await resolveEmployee(employeeId);
    authorizeBranch(scope, employee);

    // THE LIVE VERDICT, not the browser's row.
    const live = await attendanceRegularizationUsecase.shiftChangeEligibilityFor({
      employee_id: employeeId,
      attendance_date: date,
      today,
    });

    const verdict = shiftChangeBlock.canCreateBlock({
      system_can_raise: live.system.can_raise,
      request_state: live.request_state,
      active_block: live.active_block,
    });
    if (!verdict.allowed) {
      const err = validationError(verdict.refusal);
      err.refusal_code = verdict.refusal_code;
      // A system refusal is more useful with production's own sentence beside
      // it, so HR can see WHY the date is already closed.
      if (verdict.refusal_code === shiftChangeBlock.BLOCK_REFUSAL.SYSTEM_INELIGIBLE) {
        err.message = `${verdict.refusal} ${live.system.reason}`.trim();
      }
      throw err;
    }

    const created = await attendanceShiftChangeBlockRepo.create({
      employee_id: employeeId,
      attendance_date: date,
      reason: blockReason,
      // THE AUTHORIZATION BOUNDARY travels with the write: the repository
      // re-checks it against the branch it reads under the employee lock, and
      // records THAT branch as the audit snapshot. No outlet id is passed from
      // here, because the value this usecase read may already be stale.
      scope,
      blocked_by_employee_id: actor && actor.employee_id ? Number(actor.employee_id) : null,
      blocked_by_user_id: actor && actor.user_id ? Number(actor.user_id) : null,
    });

    /**
     * THE RACES, ANSWERED AS BUSINESS RATHER THAN AS SQL.
     *
     * `create` holds the shared employee lock across its own check and insert,
     * so both of these are decided by the database and not by the check above.
     *
     * A CONFLICTING REQUEST means the employee committed one while HR was
     * deciding: the date now belongs to the approval queue, and the refusal
     * says so and names the request. This is the cross-table race, and losing
     * it must never leave a block sitting beside a pending request.
     *
     * A DUPLICATE means another HR user blocked it first. The date IS blocked,
     * which is what this caller wanted - but this call did not do it and must
     * not claim the audit.
     */
    if (!created.created && created.conflicting_request) {
      const { status, attendance_approval_request_id: id } = created.conflicting_request;
      const err = validationError(
        status === "APPROVED"
          ? `A shift change request for this date was approved while you were deciding (#${id}), so it cannot be blocked.`
          : `A shift change request for this date was raised while you were deciding (#${id}). Reject it through the approval flow instead of blocking the date.`
      );
      err.refusal_code =
        status === "APPROVED"
          ? shiftChangeBlock.BLOCK_REFUSAL.REQUEST_APPROVED
          : shiftChangeBlock.BLOCK_REFUSAL.REQUEST_PENDING;
      throw err;
    }
    if (!created.created) {
      const err = validationError("This employee and date are already blocked by HR.");
      err.refusal_code = shiftChangeBlock.BLOCK_REFUSAL.ALREADY_BLOCKED;
      throw err;
    }

    const active = await attendanceShiftChangeBlockRepo.findActive(employeeId, date);
    return {
      blocked: true,
      employee_id: employeeId,
      employee_name: employee.employee_name,
      attendance_date: date,
      block: active,
    };
  };

  /**
   * ============================== REMOVE BLOCK ============================
   *
   * Removes ONLY the HR gate. It cannot make a system-ineligible date
   * eligible, cannot reopen or alter any request, and cannot touch a payroll
   * lock: all it does is fill the removal columns of the active row. Whether
   * the employee may then raise a request is decided, as it always was, by
   * production's own rule at the moment they try.
   */
  const unblockDate = async ({
    actor,
    scope,
    employee_id,
    attendance_date,
    removal_reason,
  }) => {
    const { employeeId, date } = target({ employee_id, attendance_date });
    const why = requireReason(removal_reason, "reason for removing the block");

    const employee = await resolveEmployee(employeeId);
    authorizeBranch(scope, employee);

    const active = await attendanceShiftChangeBlockRepo.findActive(employeeId, date);
    if (!shiftChangeBlock.isActive(active)) {
      throw validationError("There is no active HR block on this employee and date.");
    }

    const removed = await attendanceShiftChangeBlockRepo.remove({
      employee_id: employeeId,
      attendance_date: date,
      removed_by_employee_id: actor && actor.employee_id ? Number(actor.employee_id) : null,
      removed_by_user_id: actor && actor.user_id ? Number(actor.user_id) : null,
      removal_reason: why,
      // Re-checked under the lock, in the same transaction as the UPDATE.
      scope,
    });

    // Lost the race to another remover. The block IS gone, which is what they
    // asked for, but this call did not do it and must not claim the audit.
    if (!removed.removed) {
      throw validationError("There is no active HR block on this employee and date.");
    }

    return {
      blocked: false,
      employee_id: employeeId,
      employee_name: employee.employee_name,
      attendance_date: date,
      removed_block_id: active.attendance_shift_change_block_id,
    };
  };

  /**
   * The full block history for one employee/date - active and removed alike,
   * newest first. Read-only, and scoped exactly like the write paths.
   */
  const history = async ({ scope, employee_id, attendance_date }) => {
    const { employeeId, date } = target({ employee_id, attendance_date });
    const employee = await resolveEmployee(employeeId);
    authorizeBranch(scope, employee);
    const rows = await attendanceShiftChangeBlockRepo.listHistory(employeeId, date);
    return { employee_id: employeeId, attendance_date: date, history: rows };
  };

  return {
    MIN_REASON,
    MAX_REASON,
    blockDate,
    unblockDate,
    history,
  };
};

module.exports.MIN_REASON = MIN_REASON;
module.exports.MAX_REASON = MAX_REASON;
