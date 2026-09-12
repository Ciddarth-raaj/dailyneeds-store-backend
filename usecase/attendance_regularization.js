const {
  REQUESTER_CLASS,
  APPROVER_ROLE,
  REQUEST_TYPE,
  REQUEST_STATUS,
  STEP_DECISION,
  ADMIN_USER_TYPE,
  buildApprovalChain,
  requestTypeFor,
  canApprove,
  advance,
} = require("../utils/attendance_approval_chain");
const { CALC_STATUS } = require("../utils/attendance_engine");
const { toDateOnly } = require("../utils/shiftResolution");

/**
 * Attendance v2 / A3 - raising and deciding a regularization or OT request.
 *
 * The rules live here rather than in the route, so they can be tested without
 * a database and without Express - the same reason `usecase/work_shift.js`
 * holds the shift validation.
 *
 * WHAT MAY BE REGULARIZED, AND WHAT MAY NOT. Only a MISSING punch. A request
 * is refused for a date whose effective punch count is already even, because
 * there is nothing missing to supply; and there is no field, anywhere on this
 * path, for the id of an existing punch to replace. An existing Biomax punch
 * cannot be edited by this feature because this feature cannot name one.
 *
 * THE CONSERVATIVE DEFAULT, stated rather than hidden. A designation with no
 * row in `attendance_approval_role` is treated as STORE_EMPLOYEE for the
 * purpose of ITS OWN requests - the longest and strictest of the three chains,
 * so an unmapped designation can never end up with an easier approval path
 * than a mapped one. It is given NO approver role at all: authority is never
 * defaulted, only granted.
 *
 * OT IS APPROVED AFTER THE WORK. A candidate OT figure is calculated
 * automatically by the engine, and it is worth zero rupees until this chain
 * finishes. There is no pre-approval and no way to approve OT that has not
 * been earned: the approved figure is clamped to the candidate.
 */

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/** How far back a date may be regularized. A month of slack, not a decade. */
const MAX_BACKDATE_DAYS = 45;

module.exports = (attendanceRegularizationRepo, attendanceCalculationUsecase) => {
  /**
   * The two facts about a person the chain needs: which chain their own
   * request follows, and which stages they may decide.
   */
  const resolveIdentity = async (employeeId) => {
    const row = await attendanceRegularizationRepo.getApprovalIdentity(employeeId);
    if (!row) throw validationError(`No such employee: ${employeeId}`);

    return {
      employee_id: Number(row.employee_id),
      employee_name: row.employee_name,
      outlet_id: row.outlet_id === null || row.outlet_id === undefined ? null : Number(row.outlet_id),
      designation_id: row.designation_id,
      designation_name: row.designation_name,
      // Authority is granted, never inferred.
      approver_roles: row.approver_role ? [row.approver_role] : [],
      // The chain, where unmapped means the strictest one.
      requester_class: row.requester_class || REQUESTER_CLASS.STORE_EMPLOYEE,
      requester_class_is_default: !row.requester_class,
      is_store_manager: row.approver_role === APPROVER_ROLE.STORE_MANAGER,
    };
  };

  /**
   * Raise ONE request for ONE date.
   *
   * A date that has both a missing punch and resulting overtime raises a
   * single REGULARIZATION_WITH_OT request on a single chain, so there is one
   * decision to make and one audit trail to read. The final approval on it
   * approves both.
   */
  const raiseRequest = async ({
    actor,
    requested_for_employee_id,
    attendance_date,
    reason,
    punch_time = null,
  }) => {
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    if (typeof reason !== "string" || reason.trim().length < 5) {
      throw validationError("A reason of at least 5 characters is required");
    }

    const forEmployeeId = Number(requested_for_employee_id);
    if (!Number.isInteger(forEmployeeId) || forEmployeeId <= 0) {
      throw validationError("requested_for_employee_id must be an employee id");
    }

    const open = await attendanceRegularizationRepo.findOpenRequest(forEmployeeId, date);
    if (open) {
      throw validationError(
        `There is already an open request for ${date} (#${open.attendance_approval_request_id})`
      );
    }

    // Recalculate the date now rather than trusting anything the caller sent.
    // What is being regularized has to be what the engine actually says is
    // wrong with the date, not what a screen believed a while ago.
    const [day] = await attendanceCalculationUsecase.calculateRange({
      employee_id: forEmployeeId,
      from_date: date,
      to_date: date,
    });

    if (!day || !day.shift_snapshot) {
      throw validationError(
        `${date} has no work shift resolved for this employee, so there is nothing to calculate yet`
      );
    }

    const hasMissingPunch = day.punch_count % 2 === 1;
    const hasCandidateOt = day.candidate_ot_minutes > 0;

    if (!hasMissingPunch && !hasCandidateOt) {
      throw validationError(
        `${date} has ${day.punch_count} punches and no overtime, so there is nothing to approve`
      );
    }

    if (hasMissingPunch) {
      if (!punch_time) {
        throw validationError("punch_time is required when a punch is missing");
      }
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(punch_time).trim())) {
        throw validationError("punch_time must be YYYY-MM-DD HH:MM:SS");
      }
    } else if (punch_time) {
      // Nothing is missing, so a manual punch here would be an edit to a
      // complete day rather than a regularization. Refused, not ignored.
      throw validationError(
        `${date} already has an even number of punches - a punch cannot be added to a complete day`
      );
    }

    const identity = await resolveIdentity(forEmployeeId);
    const chain = buildApprovalChain({
      requester_class: identity.requester_class,
      outlet_id: identity.outlet_id,
      requester_is_store_manager: identity.is_store_manager,
    });

    if (chain.some((s) => s.approver_role === APPROVER_ROLE.STORE_MANAGER && s.outlet_id === null)) {
      throw validationError(
        "This employee has no outlet, so their Store Manager stage cannot be addressed"
      );
    }

    const created = await attendanceRegularizationRepo.createRequest({
      request: {
        request_type: requestTypeFor({
          has_missing_punch: hasMissingPunch,
          has_candidate_ot: hasCandidateOt,
        }),
        requested_for_employee_id: forEmployeeId,
        requested_by_employee_id: Number(actor.employee_id),
        attendance_date: date,
        outlet_id: identity.outlet_id,
        requester_class: identity.requester_class,
        reason: reason.trim(),
        candidate_ot_minutes: day.candidate_ot_minutes,
      },
      chain,
      punch: hasMissingPunch ? { punch_time: String(punch_time).trim() } : null,
    });

    return {
      ...created,
      attendance_date: date,
      chain,
      candidate_ot_minutes: day.candidate_ot_minutes,
      requester_class: identity.requester_class,
      requester_class_is_default: identity.requester_class_is_default,
    };
  };

  /**
   * Decide the CURRENT stage of a request.
   *
   * The permission to reach this endpoint is not the authority to decide this
   * stage: `canApprove` is what decides that, from the actor's mapped role,
   * their outlet, and whose request it is. An administrator may decide a stage
   * they hold no role for - as they may everywhere else in this backend - and
   * the step records it as an override so the short-cut is visible afterwards.
   *
   * On FINAL approval the date is recalculated immediately, which is what
   * turns the regularized punch into worked minutes and the candidate OT into
   * payable OT. The recalculation is idempotent, so a retried approval cannot
   * double anything.
   */
  const decide = async ({ actor, request_id, decision, remarks = null }) => {
    if (decision !== STEP_DECISION.APPROVED && decision !== STEP_DECISION.REJECTED) {
      throw validationError("decision must be APPROVED or REJECTED");
    }

    const request = await attendanceRegularizationRepo.getRequest(request_id);
    if (!request) throw validationError(`No such request: ${request_id}`);

    const step = (request.steps || []).find(
      (s) => Number(s.stage_no) === Number(request.current_stage_no)
    );
    if (!step) throw validationError("This request has no current stage - it is already finished");

    const identity = await resolveIdentity(actor.employee_id);
    const verdict = canApprove(
      step,
      {
        employee_id: identity.employee_id,
        user_type: actor.user_type,
        outlet_id: identity.outlet_id,
        approver_roles: identity.approver_roles,
      },
      request
    );
    if (!verdict.allowed) {
      const err = new Error(verdict.reason);
      err.name = "ForbiddenError";
      throw err;
    }

    const chain = request.steps.map((s) => ({
      stage_no: Number(s.stage_no),
      approver_role: s.approver_role,
      outlet_id: s.outlet_id,
    }));
    const next = advance(request, chain, decision);

    // The approved figure is set on FINAL approval only, and is clamped to the
    // candidate that was calculated when the request was raised: approving is
    // a decision about earned overtime, not a way to create it.
    const approvedOt =
      next.status === REQUEST_STATUS.APPROVED
        ? Math.max(0, Math.trunc(Number(request.candidate_ot_minutes) || 0))
        : null;

    const saved = await attendanceRegularizationRepo.decideStage({
      requestId: Number(request_id),
      stageNo: Number(step.stage_no),
      decision,
      actorId: identity.employee_id,
      remarks,
      adminOverride: verdict.as_admin_override,
      next: { ...next, approved_ot_minutes: approvedOt },
    });
    if (saved.code !== 200) return saved;

    // Whatever the outcome, the date's stored calculation is now stale: an
    // approval adds a punch and unlocks OT, a rejection ends the pending state
    // that was holding the date out of payroll.
    const recalculated = await attendanceCalculationUsecase.recalculateRange({
      employee_id: request.requested_for_employee_id,
      from_date: request.attendance_date,
      to_date: request.attendance_date,
    });

    return {
      code: 200,
      attendance_approval_request_id: Number(request_id),
      stage_no: Number(step.stage_no),
      decision,
      acted_as_admin_override: verdict.as_admin_override,
      status: saved.status,
      current_stage_no: saved.current_stage_no,
      approved_ot_minutes: approvedOt,
      attendance_date: request.attendance_date,
      recalculated: recalculated.days ? recalculated.days[0] : null,
    };
  };

  /** The queue: requests whose current stage this actor could decide. */
  const listPending = async ({ actor, limit }) => {
    const identity = await resolveIdentity(actor.employee_id);
    const roles = [...identity.approver_roles];
    // An administrator sees every stage, because they may decide any of them.
    if (Number(actor.user_type) === ADMIN_USER_TYPE) {
      Object.values(APPROVER_ROLE).forEach((role) => {
        if (!roles.includes(role)) roles.push(role);
      });
    }
    if (roles.length === 0) return { rows: [], approver_roles: [] };

    const rows = await attendanceRegularizationRepo.listPendingFor({
      approver_roles: roles,
      outlet_id: identity.outlet_id,
      actor_employee_id: identity.employee_id,
      limit,
    });
    return { rows, approver_roles: roles };
  };

  const getRequest = (requestId) => attendanceRegularizationRepo.getRequest(requestId);

  const listForEmployee = (filters) => attendanceRegularizationRepo.listForEmployee(filters);

  return {
    MAX_BACKDATE_DAYS,
    REQUESTER_CLASS,
    APPROVER_ROLE,
    REQUEST_TYPE,
    REQUEST_STATUS,
    STEP_DECISION,
    CALC_STATUS,
    resolveIdentity,
    raiseRequest,
    decide,
    listPending,
    listForEmployee,
    getRequest,
  };
};
