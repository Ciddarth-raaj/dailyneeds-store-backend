const {
  REQUESTER_CLASS,
  APPROVER_ROLE,
  REQUEST_TYPE,
  REQUEST_STATUS,
  STEP_DECISION,
  ADMIN_USER_TYPE,
  CHAIN_SOURCE,
  buildApprovalChain,
  buildEmployeeApprovalChain,
  canApprove,
  advance,
} = require("../utils/attendance_approval_chain");
const { CALC_STATUS, addDays } = require("../utils/attendance_engine");
const { toDateOnly } = require("../utils/shiftResolution");
const { istToday } = require("../utils/istDate");

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
 * MISSING PUNCH AND OT ARE TWO REQUESTS (finalized OT flow). A regularization
 * request carries the proposed punch and the employee's reason, and its
 * approval corrects ATTENDANCE only. Once the corrected day is recalculated,
 * any candidate OT the engine now finds is merely AVAILABLE; the employee
 * raises a separate OT request for it, with a reason, and OT approval runs on
 * its own. New code never creates REGULARIZATION_WITH_OT; the enum value is
 * kept so historical rows still read.
 *
 * OT IS REQUESTED BY THE EMPLOYEE, NEVER QUEUED BY THE SYSTEM. The engine
 * calculates `candidate_ot_minutes`; that figure is system-controlled and the
 * request body has no field for it. `raiseOtRequest` recalculates the date on
 * the server at submission and stores THAT candidate. Approval is after the
 * work, and the approved figure is clamped to the eligible OT as calculated at
 * the moment of final approval, so it can never exceed what the engine says.
 *
 * PAYROLL LOCK closes every OT claim in the month that is not finally
 * approved - never requested, or requested and not approved in time - as
 * REJECTED with a closure reason, so no open OT request survives a locked
 * period. `closeOtForPayrollLock` is that rule; there is no lock action yet
 * that calls it, and it is exposed on the payroll usecase for the one that
 * will.
 *
 * A FINAL DECISION AND THE ATTENDANCE IT CAUSES COMMIT TOGETHER (review fix
 * #4). `decide` computes the corrected day BEFORE it opens the decision
 * transaction and hands the rows to the repository, which writes them inside
 * it. A storage failure rolls the decision back; there is no window in which a
 * request is APPROVED while the stored day is still the one from before it.
 */

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/** How far back a date may be regularized. A month of slack, not a decade. */
const MAX_BACKDATE_DAYS = 45;

/**
 * `approverSetupRepo` is the EMPLOYEE-LEVEL approver store (Attendance
 * Approver Setup). It is optional: without it every request follows the role
 * chain exactly as before, which is also what happens for an employee who has
 * no active mapping yet. With it, `resolveChain` snapshots the mapped approver
 * ids onto the request at creation. ONE chain per request, never a mix.
 */
module.exports = (attendanceRegularizationRepo, attendanceCalculationUsecase, approverSetupRepo = null) => {
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

  /** The exact closure wording the payroll lock records. */
  const OT_CLOSURE = Object.freeze({
    NOT_REQUESTED_BEFORE_PAYROLL_LOCK: {
      code: "NOT_REQUESTED_BEFORE_PAYROLL_LOCK",
      label: "Rejected – Not Requested Before Payroll Lock",
    },
    NOT_APPROVED_BEFORE_PAYROLL_LOCK: {
      code: "NOT_APPROVED_BEFORE_PAYROLL_LOCK",
      label: "Rejected – Not Approved Before Payroll Lock",
    },
  });

  /**
   * Which chain a NEW request walks, resolved once and snapshotted.
   *
   *   mapped employee    the employee-level chain from Attendance Approver
   *                      Setup: First -> Second -> Final with blank levels
   *                      skipped, each step carrying the approver's id
   *   unmapped employee  the existing designation/outlet role chain,
   *                      unchanged - the backward-compatible fallback
   *
   * The two are never combined inside one request.
   */
  const resolveChain = async (identity) => {
    if (approverSetupRepo && typeof approverSetupRepo.getActiveSetup === "function") {
      const setup = await approverSetupRepo.getActiveSetup(identity.employee_id);
      if (setup && setup.final_approver_employee_id) {
        return { chain: buildEmployeeApprovalChain(setup), source: CHAIN_SOURCE.EMPLOYEE };
      }
    }
    return { chain: chainFor(identity), source: CHAIN_SOURCE.ROLE };
  };

  /** The ROLE chain for somebody's own request, with the outlet check every raise needs. */
  const chainFor = (identity) => {
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
    return chain;
  };

  /**
   * Raise a MISSING PUNCH regularization for ONE date.
   *
   * Attendance correction only. The request carries the proposed punch, the
   * employee's reason and the attendance approval chain - and NO overtime:
   * whatever OT the corrected day turns out to earn becomes available for a
   * separate OT request once this one is finally approved and the date is
   * recalculated.
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

    if (day.punch_count % 2 !== 1) {
      // Nothing is missing, so a manual punch here would be an edit to a
      // complete day rather than a regularization. Refused, not ignored. (OT
      // on a complete day is an OT request, not this.)
      throw validationError(
        `${date} has ${day.punch_count} punches - a punch cannot be added to a complete day`
      );
    }
    if (!punch_time) {
      throw validationError("punch_time is required when a punch is missing");
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(punch_time).trim())) {
      throw validationError("punch_time must be YYYY-MM-DD HH:MM:SS");
    }
    const punchTime = String(punch_time).trim();

    // The proposed punch has to belong to the date being regularized, under
    // the cutoff that applied on that date. A 00:30 OUT after a 10:00-22:00
    // shift does; a 09:00 punch on the following morning does not, and
    // approving it would silently credit a different day.
    const resolvedDate = await attendanceCalculationUsecase.attendanceDateForPunchTime({
      employee_id: forEmployeeId,
      punch_time: punchTime,
      near_date: date,
    });
    if (resolvedDate !== date) {
      throw validationError(
        `A punch at ${punchTime} belongs to attendance date ${
          resolvedDate === null ? "none" : resolvedDate
        } under this employee's shift and cutoff for ${date}, not to ${date}`
      );
    }

    // Run the SAME engine over raw punches plus the proposed one, to prove the
    // corrected day is calculable. Nothing is stored, and NOTHING about its
    // overtime is carried onto this request.
    const proposedDay = await attendanceCalculationUsecase.calculateProposedDay({
      employee_id: forEmployeeId,
      attendance_date: date,
      punch_time: punchTime,
    });
    if (!proposedDay || proposedDay.punch_count % 2 === 1) {
      throw validationError(
        `A punch at ${punchTime} still leaves ${date} with an odd number of punches, so it cannot be what was missing`
      );
    }
    if (proposedDay.status === CALC_STATUS.REVIEW_REQUIRED) {
      throw validationError(`A punch at ${punchTime} does not produce a calculable day for ${date}`);
    }

    const identity = await resolveIdentity(forEmployeeId);
    const { chain, source: chain_source } = await resolveChain(identity);

    const created = await attendanceRegularizationRepo.createRequest({
      request: {
        request_type: REQUEST_TYPE.REGULARIZATION,
        requested_for_employee_id: forEmployeeId,
        requested_by_employee_id: Number(actor.employee_id),
        attendance_date: date,
        outlet_id: identity.outlet_id,
        requester_class: identity.requester_class,
        reason: reason.trim(),
        candidate_ot_minutes: 0,
        auto_created: false,
        chain_source,
      },
      chain,
      punch: { punch_time: punchTime },
    });

    return {
      ...created,
      request_type: REQUEST_TYPE.REGULARIZATION,
      attendance_date: date,
      chain,
      chain_source,
      // What the day would look like if this were approved, so an approver can
      // be shown the corrected day rather than the broken one. Its candidate
      // OT is informational: it becomes claimable only after approval.
      proposed_day: proposedDay,
      requester_class: identity.requester_class,
      requester_class_is_default: identity.requester_class_is_default,
    };
  };

  /**
   * Raise an OT REQUEST for ONE date, by the employee, for themselves.
   *
   * The caller supplies a date and a reason and nothing else. The candidate
   * OT is whatever the engine calculates for that date RIGHT NOW on the
   * server - `candidate_ot_minutes` from a request body is not a field this
   * function has - and it is stored on the request so the approver sees the
   * figure that was claimed, then clamped again at final approval.
   *
   * Refused when: the day has no candidate OT; the day is not a complete,
   * FINAL day (a missing punch is a regularization, not an OT claim); an OT
   * request for the date already exists in any decided or open state (one
   * claim per date - a fresh claim after rejection is not a policy this
   * invents); the date is in the future or older than the backdate window.
   */
  const raiseOtRequest = async ({ actor, attendance_date, reason, today = null }) => {
    const employeeId = Number(actor && actor.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("An employee identity is required to request OT");
    }
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    if (typeof reason !== "string" || reason.trim().length < 5) {
      throw validationError("A reason of at least 5 characters is required");
    }

    const businessToday = istToday(today);
    if (date > businessToday) throw validationError("OT cannot be requested for a future date");
    if (date < addDays(businessToday, -MAX_BACKDATE_DAYS)) {
      throw validationError(`OT can be requested for the last ${MAX_BACKDATE_DAYS} days only`);
    }

    // The employee must exist; the chain needs their identity anyway.
    const identity = await resolveIdentity(employeeId);

    // One claim per date, whatever its state. PENDING is also enforced by the
    // database's unique open-request key, so a concurrent retry cannot slip a
    // second one in between this check and the insert.
    const existing = await attendanceRegularizationRepo.findRequestsForDates(employeeId, [date]);
    const priorOt = (existing || []).find((r) => r.request_type === REQUEST_TYPE.OT);
    if (priorOt) {
      const state =
        priorOt.status === REQUEST_STATUS.PENDING
          ? "is already pending"
          : priorOt.status === REQUEST_STATUS.APPROVED
          ? "has already been approved"
          : "has already been decided";
      throw validationError(
        `An OT request for ${date} ${state} (#${priorOt.attendance_approval_request_id})`
      );
    }
    const openOther = (existing || []).find((r) => r.status === REQUEST_STATUS.PENDING);
    if (openOther) {
      throw validationError(
        `${date} has an open attendance request (#${openOther.attendance_approval_request_id}); OT can be requested once it is decided`
      );
    }

    // The server's own calculation, now. Never the caller's figure.
    const [day] = await attendanceCalculationUsecase.calculateRange({
      employee_id: employeeId,
      from_date: date,
      to_date: date,
    });
    if (!day || !day.shift_snapshot) {
      throw validationError(`${date} has no work shift resolved, so there is no overtime to request`);
    }
    if (day.is_final !== true || day.status !== CALC_STATUS.FINAL || day.punch_count % 2 === 1) {
      throw validationError(
        `${date} is not a complete attendance day yet, so its overtime cannot be requested`
      );
    }
    const candidate = Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0));
    if (candidate <= 0) {
      throw validationError(`${date} has no overtime calculated, so there is nothing to request`);
    }

    const { chain, source: chain_source } = await resolveChain(identity);
    const created = await attendanceRegularizationRepo.createRequest({
      request: {
        request_type: REQUEST_TYPE.OT,
        requested_for_employee_id: employeeId,
        requested_by_employee_id: employeeId,
        attendance_date: date,
        outlet_id: identity.outlet_id,
        requester_class: identity.requester_class,
        reason: reason.trim(),
        candidate_ot_minutes: candidate,
        auto_created: false,
        chain_source,
      },
      chain,
      punch: null,
    });

    return {
      ...created,
      request_type: REQUEST_TYPE.OT,
      attendance_date: date,
      candidate_ot_minutes: candidate,
      approved_ot_minutes: 0,
      chain,
      chain_source,
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
   * On FINAL approval the date is recalculated and STORED IN THE SAME
   * TRANSACTION as the decision (review fix #4). The corrected day is computed
   * before the transaction opens, with this decision assumed, and the rows are
   * handed to the repository to write on its own connection: if storing them
   * fails, the decision is rolled back with them and the request is still
   * PENDING. There is no ordering in which payroll can see an APPROVED request
   * whose day has not been recalculated. The recalculation is idempotent, so a
   * retried approval cannot double anything.
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
      approver_employee_id: s.approver_employee_id === undefined ? null : s.approver_employee_id,
      approval_level: s.approval_level === undefined ? null : s.approval_level,
    }));
    const next = advance(request, chain, decision);

    const isOtRequest = request.request_type === REQUEST_TYPE.OT;
    const carriesOt = isOtRequest || request.request_type === REQUEST_TYPE.REGULARIZATION_WITH_OT;

    // The approved figure is set on FINAL approval only, and it can NEVER
    // exceed the eligible OT. For an OT request that is the LOWER of what was
    // claimed when it was raised and what the engine calculates for the date
    // right now - if the candidate has since moved down (a shift edit, a
    // recalculation), the approval follows it down rather than paying minutes
    // the engine no longer finds. A plain regularization approves no OT at
    // all; whatever the corrected day earns becomes available to claim.
    let approvedOt = null;
    if (next.status === REQUEST_STATUS.APPROVED && carriesOt) {
      const claimed = Math.max(0, Math.trunc(Number(request.candidate_ot_minutes) || 0));
      if (isOtRequest) {
        const [currentDay] = await attendanceCalculationUsecase.calculateRange({
          employee_id: request.requested_for_employee_id,
          from_date: request.attendance_date,
          to_date: request.attendance_date,
        });
        const eligible = currentDay
          ? Math.max(0, Math.trunc(Number(currentDay.candidate_ot_minutes) || 0))
          : 0;
        approvedOt = Math.min(claimed, eligible);
      } else {
        approvedOt = claimed;
      }
    } else if (next.status === REQUEST_STATUS.APPROVED) {
      approvedOt = 0;
    }

    // Whatever the outcome, the date's stored calculation is about to be stale:
    // an approval makes the punch effective (attendance only - any OT the
    // corrected day earns becomes AVAILABLE to request), a rejection ends the pending
    // state that was holding the date out of payroll. Compute the corrected
    // day NOW, with this decision assumed, so it can be committed with it.
    const [correctedDay] = await attendanceCalculationUsecase.calculateRange({
      employee_id: request.requested_for_employee_id,
      from_date: request.attendance_date,
      to_date: request.attendance_date,
      assume: {
        attendance_approval_request_id: Number(request_id),
        attendance_date: request.attendance_date,
        request_type: request.request_type,
        status: next.status,
        candidate_ot_minutes: request.candidate_ot_minutes,
        reason: request.reason,
        approved_ot_minutes: approvedOt || 0,
        regularized_punch:
          next.status === REQUEST_STATUS.APPROVED && request.regularized_punch
            ? {
                punch_id: request.regularized_punch.attendance_regularized_punch_id,
                io_time: request.regularized_punch.punch_time,
              }
            : null,
      },
    });

    const saved = await attendanceRegularizationRepo.decideStage({
      requestId: Number(request_id),
      stageNo: Number(step.stage_no),
      decision,
      actorId: identity.employee_id,
      remarks,
      adminOverride: verdict.as_admin_override,
      next: { ...next, approved_ot_minutes: approvedOt },
      calculations: correctedDay ? [attendanceCalculationUsecase.toStorageRow(correctedDay)] : [],
    });
    if (saved.code !== 200) return saved;

    return {
      code: 200,
      attendance_approval_request_id: Number(request_id),
      stage_no: Number(step.stage_no),
      decision,
      acted_as_admin_override: verdict.as_admin_override,
      status: saved.status,
      current_stage_no: saved.current_stage_no,
      finalization_state: saved.finalization_state,
      approved_ot_minutes: approvedOt,
      attendance_date: request.attendance_date,
      recalculated: correctedDay || null,
      // Attendance approval corrects attendance only. If the corrected day now
      // earns overtime, it is merely AVAILABLE - the employee claims it.
      ot_now_available:
        !isOtRequest && correctedDay && correctedDay.ot_claim_state === "AVAILABLE"
          ? Number(correctedDay.candidate_ot_minutes) || 0
          : 0,
    };
  };

  /**
   * PAYROLL LOCK: close every OT claim in a period that is not finally
   * approved.
   *
   *   never requested   -> a REJECTED OT record is written for the date with
   *                        closure NOT_REQUESTED_BEFORE_PAYROLL_LOCK, carrying
   *                        the candidate the engine reported, so the date
   *                        reads "Rejected – Not Requested Before Payroll
   *                        Lock" afterwards and can no longer be claimed
   *   pending           -> REJECTED with closure NOT_APPROVED_BEFORE_PAYROLL_LOCK,
   *                        every outstanding step stamped SKIPPED
   *   rejected          -> untouched
   *   finally approved  -> untouched, and paid
   *
   * `days` is the period as the payroll usecase has just calculated it, so
   * the "available" dates are the engine's answer at the moment of lock and
   * nothing is re-derived from a stale stored row. Idempotent: a date that
   * already has any OT record - open, decided or closed - is left alone, so a
   * second run writes nothing. NOTHING here marks candidate OT payable.
   */
  const closeOtForPayrollLock = async ({ employee_id, from_date, to_date, days, actor_employee_id = null }) => {
    const employeeId = Number(employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required");
    }
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null || from > to) {
      throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    }

    const unrequested = (days || [])
      .filter(
        (day) =>
          day &&
          day.attendance_date >= from &&
          day.attendance_date <= to &&
          day.ot_claim_state === "AVAILABLE" &&
          Number(day.candidate_ot_minutes) > 0
      )
      .map((day) => ({
        attendance_date: day.attendance_date,
        candidate_ot_minutes: Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0)),
      }));

    let identity = null;
    if (unrequested.length > 0) identity = await resolveIdentity(employeeId);

    const closed = await attendanceRegularizationRepo.closeOtAtPayrollLock({
      employee_id: employeeId,
      from_date: from,
      to_date: to,
      pending_closure: OT_CLOSURE.NOT_APPROVED_BEFORE_PAYROLL_LOCK,
      unrequested_closure: OT_CLOSURE.NOT_REQUESTED_BEFORE_PAYROLL_LOCK,
      unrequested: unrequested.map((u) => ({
        ...u,
        outlet_id: identity ? identity.outlet_id : null,
        requester_class: identity ? identity.requester_class : REQUESTER_CLASS.STORE_EMPLOYEE,
        closed_by: actor_employee_id === undefined ? null : actor_employee_id,
      })),
    });

    return {
      employee_id: employeeId,
      from_date: from,
      to_date: to,
      closed_unrequested: closed.closed_unrequested || 0,
      rejected_pending: closed.rejected_pending || 0,
      approved_preserved: (days || []).filter((d) => d && d.ot_claim_state === "APPROVED").length,
      unrequested_dates: unrequested.map((u) => u.attendance_date),
    };
  };

  /** The roles an actor decides with: their mapped role, or every role for an administrator. */
  const rolesFor = (identity, actor) => {
    const roles = [...identity.approver_roles];
    if (Number(actor.user_type) === ADMIN_USER_TYPE) {
      Object.values(APPROVER_ROLE).forEach((role) => {
        if (!roles.includes(role)) roles.push(role);
      });
    }
    return roles;
  };

  const APPROVAL_TYPES = [REQUEST_TYPE.REGULARIZATION, REQUEST_TYPE.OT];
  const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ALL"];

  const parseJson = (value, fallback) => {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (err) {
      return fallback;
    }
  };

  /**
   * The approval screens: ONE request type, ONE status filter, the actor's
   * own scope.
   *
   * Attendance Approval asks for REGULARIZATION and OT Approval asks for OT;
   * the two never mix, by the filter. PENDING is "pending with me": the
   * requests whose CURRENT stage this actor could decide now, each also
   * checked through `canApprove` so a row is never shown as actionable when
   * it is not. History is what the actor's role and outlet entitled them to
   * see; the repository's scope is the same for the list and the count.
   *
   * Every PENDING row's day is calculated LIVE, so the punches, NRM, worked,
   * shortage and eligible OT an approver decides on are the engine's answer
   * now rather than a stored row from an earlier run. History rows read the
   * stored calculation, which is what the decision was made against.
   */
  const listApprovals = async ({ actor, request_type, status = "PENDING", limit = 200, offset = 0 }) => {
    if (!APPROVAL_TYPES.includes(request_type)) {
      throw validationError("request_type must be REGULARIZATION or OT");
    }
    if (!APPROVAL_STATUSES.includes(status)) {
      throw validationError("status must be PENDING, APPROVED, REJECTED or ALL");
    }
    const identity = await resolveIdentity(actor.employee_id);
    const isAdmin = Number(actor.user_type) === ADMIN_USER_TYPE;
    const roles = rolesFor(identity, actor);
    const scope = {
      request_type,
      status,
      approver_roles: roles,
      outlet_id: identity.outlet_id,
      actor_employee_id: identity.employee_id,
      is_admin: isAdmin,
    };

    const [rows, total] = await Promise.all([
      attendanceRegularizationRepo.listApprovals({ ...scope, limit, offset }),
      attendanceRegularizationRepo.countApprovals(scope),
    ]);
    const steps = await attendanceRegularizationRepo.listStepsForRequests(
      rows.map((r) => Number(r.attendance_approval_request_id))
    );
    const stepsByRequest = new Map();
    steps.forEach((st) => {
      const id = Number(st.attendance_approval_request_id);
      if (!stepsByRequest.has(id)) stepsByRequest.set(id, []);
      stepsByRequest.get(id).push(st);
    });

    const shaped = [];
    for (const row of rows) {
      const id = Number(row.attendance_approval_request_id);
      const chain = stepsByRequest.get(id) || [];
      const currentStep = chain.find((st) => Number(st.stage_no) === Number(row.current_stage_no)) || null;

      let day = null;
      if (row.status === REQUEST_STATUS.PENDING) {
        /* eslint-disable no-await-in-loop */
        const [live] = await attendanceCalculationUsecase.calculateRange({
          employee_id: Number(row.requested_for_employee_id),
          from_date: row.attendance_date,
          to_date: row.attendance_date,
        });
        /* eslint-enable no-await-in-loop */
        day = live || null;
      }
      const snapshot = day ? day.shift_snapshot : parseJson(row.shift_snapshot, null);
      const punches = day ? day.effective_punches : parseJson(row.effective_punches, []);

      const verdict =
        row.status === REQUEST_STATUS.PENDING && currentStep
          ? canApprove(
              currentStep,
              {
                employee_id: identity.employee_id,
                user_type: actor.user_type,
                outlet_id: identity.outlet_id,
                approver_roles: identity.approver_roles,
              },
              row
            )
          : { allowed: false, reason: null };

      const decidedStep = [...chain]
        .reverse()
        .find((st) => st.decision === STEP_DECISION.APPROVED || st.decision === STEP_DECISION.REJECTED);
      const claimed = Math.max(0, Math.trunc(Number(row.candidate_ot_minutes) || 0));
      const eligible = day
        ? Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0))
        : row.stored_candidate_ot_minutes === null || row.stored_candidate_ot_minutes === undefined
        ? claimed
        : Math.max(0, Math.trunc(Number(row.stored_candidate_ot_minutes) || 0));

      shaped.push({
        attendance_approval_request_id: id,
        request_type: row.request_type,
        status: row.status,
        employee_id: Number(row.requested_for_employee_id),
        employee_name: row.employee_name || null,
        requested_by_employee_id: Number(row.requested_by_employee_id),
        outlet_id: row.outlet_id === null ? null : Number(row.outlet_id),
        outlet_name: row.outlet_name || null,
        attendance_date: row.attendance_date,
        reason: row.reason,
        submitted_at: row.created_at,
        decided_at: row.decided_at || null,
        decided_by_employee_id: decidedStep ? decidedStep.decided_by_employee_id : null,
        decided_by_name: decidedStep ? decidedStep.decided_by_name || null : null,
        closure_reason: row.closure_reason || null,
        closure_label: row.closure_reason && OT_CLOSURE[row.closure_reason]
          ? OT_CLOSURE[row.closure_reason].label
          : null,
        current_stage_no: Number(row.current_stage_no),
        total_stages: Number(row.total_stages),
        current_stage_role: currentStep ? currentStep.approver_role : null,
        // Employee-level chains name a person for the stage; role chains do not.
        chain_source: row.chain_source || null,
        current_stage_approval_level: currentStep ? currentStep.approval_level || null : null,
        current_stage_approver_employee_id:
          currentStep && currentStep.approver_employee_id !== null && currentStep.approver_employee_id !== undefined
            ? Number(currentStep.approver_employee_id)
            : null,
        current_stage_approver_name: currentStep ? currentStep.approver_name || null : null,
        actionable: !!verdict.allowed,
        not_actionable_reason: verdict.allowed ? null : verdict.reason,
        // The proposed missing punch (regularization only).
        proposed_punch_time: row.proposed_punch_time || null,
        // The day, live for pending rows and stored for history.
        shift_name: row.shift_name || (day ? day.shift_name : null) || null,
        shift_code: snapshot ? snapshot.shift_code || null : null,
        shift_in_time: snapshot ? snapshot.in_time || null : null,
        shift_out_time: snapshot ? snapshot.out_time || null : null,
        effective_punches: Array.isArray(punches) ? punches : [],
        nrm_minutes: day ? day.nrm_minutes : row.nrm_minutes,
        worked_minutes: day ? day.worked_minutes : row.worked_minutes,
        shortage_minutes: day ? day.shortage_minutes : row.shortage_minutes,
        // OT: what was claimed when raised, what the engine finds eligible,
        // and what was finally approved. Never editable by an approver - the
        // decision endpoint takes no minutes at all.
        claimed_ot_minutes: request_type === REQUEST_TYPE.OT ? claimed : 0,
        eligible_ot_minutes: request_type === REQUEST_TYPE.OT ? Math.min(claimed, eligible) : 0,
        approved_ot_minutes:
          row.approved_ot_minutes === null || row.approved_ot_minutes === undefined
            ? 0
            : Math.max(0, Math.trunc(Number(row.approved_ot_minutes) || 0)),
        chain: chain.map((st) => ({
          stage_no: Number(st.stage_no),
          approver_role: st.approver_role,
          outlet_id: st.outlet_id === null ? null : Number(st.outlet_id),
          approval_level: st.approval_level || null,
          approver_employee_id:
            st.approver_employee_id === null || st.approver_employee_id === undefined
              ? null
              : Number(st.approver_employee_id),
          approver_name: st.approver_name || null,
          decision: st.decision,
          decided_by_employee_id: st.decided_by_employee_id,
          decided_by_name: st.decided_by_name || null,
          decided_at: st.decided_at || null,
          remarks: st.remarks || null,
          acted_as_admin_override: Number(st.acted_as_admin_override) === 1,
        })),
      });
    }

    return { rows: shaped, total, request_type, status, limit, offset, approver_roles: roles };
  };

  /** "Pending with me", counted in SQL for one request type. */
  const countPending = async ({ actor, request_type }) => {
    if (!APPROVAL_TYPES.includes(request_type)) {
      throw validationError("request_type must be REGULARIZATION or OT");
    }
    const identity = await resolveIdentity(actor.employee_id);
    const count = await attendanceRegularizationRepo.countApprovals({
      request_type,
      status: "PENDING",
      approver_roles: rolesFor(identity, actor),
      outlet_id: identity.outlet_id,
      actor_employee_id: identity.employee_id,
      is_admin: Number(actor.user_type) === ADMIN_USER_TYPE,
    });
    return { request_type, pending_with_me: count };
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
    // No role does not mean no queue: an employee-level step may name them.
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
    OT_CLOSURE,
    resolveIdentity,
    resolveChain,
    raiseRequest,
    raiseOtRequest,
    closeOtForPayrollLock,
    decide,
    listApprovals,
    countPending,
    listPending,
    listForEmployee,
    getRequest,
  };
};
