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
const logger = require("../utils/logger");

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
 *
 * THE CANDIDATE OT ON A MISSING-PUNCH REQUEST IS THE OT THE PROPOSED PUNCH
 * WOULD CREATE (review fix #3). An odd punch count leaves the engine before
 * overtime is calculated at all, so asking the INCOMPLETE day what its
 * overtime is always answers zero - which is how a missing 00:30 OUT that
 * plainly earns two hours of OT could reach an approver showing none. The
 * proposed punch is therefore put into a PROPOSED effective punch list in
 * memory, the same engine is run over it, and the candidate comes from that
 * corrected day. Nothing is made effective in stored attendance by this: the
 * punch row stays invisible to the calculation until the chain finishes.
 *
 * ROUTINE OT QUEUES ITSELF (review fix #6). Nobody should have to know to ask
 * for overtime they have already worked. When a recalculation finds candidate
 * OT on a complete, valid day with no request against it, `otAutoQueue` raises
 * the OT request on the same role/outlet chain, and when a later recalculation
 * finds the overtime gone it supersedes its own request rather than leaving
 * stale payable OT in the queue.
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
    auto_created = false,
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

    // The OT the request actually carries. On a complete day it is the day's
    // own candidate; on a missing-punch day it is the OT the PROPOSED punch
    // would create, and deriving it any other way gives zero (review fix #3).
    let candidateOtMinutes = day.candidate_ot_minutes;
    let proposedDay = null;

    if (hasMissingPunch) {
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

      // Run the SAME engine over raw punches plus the proposed one. Nothing is
      // stored; this is what the day would look like if it were approved.
      proposedDay = await attendanceCalculationUsecase.calculateProposedDay({
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
        throw validationError(
          `A punch at ${punchTime} does not produce a calculable day for ${date}`
        );
      }

      candidateOtMinutes = proposedDay.candidate_ot_minutes;
    } else if (punch_time) {
      // Nothing is missing, so a manual punch here would be an edit to a
      // complete day rather than a regularization. Refused, not ignored.
      throw validationError(
        `${date} already has an even number of punches - a punch cannot be added to a complete day`
      );
    }

    // The TYPE follows the corrected day, not the broken one: a missing punch
    // that creates overtime is one REGULARIZATION_WITH_OT request on one
    // chain, and the final approval on it makes both effective in one pass.
    const carriesOt = candidateOtMinutes > 0;

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
          has_candidate_ot: carriesOt,
        }),
        requested_for_employee_id: forEmployeeId,
        requested_by_employee_id: Number(actor.employee_id),
        attendance_date: date,
        outlet_id: identity.outlet_id,
        requester_class: identity.requester_class,
        reason: reason.trim(),
        candidate_ot_minutes: candidateOtMinutes,
        auto_created: !!auto_created,
      },
      chain,
      punch: hasMissingPunch ? { punch_time: String(punch_time).trim() } : null,
    });

    return {
      ...created,
      attendance_date: date,
      chain,
      candidate_ot_minutes: candidateOtMinutes,
      // What the day would look like if this were approved, so an approver can
      // be shown the corrected day rather than the broken one.
      proposed_day: proposedDay,
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
    }));
    const next = advance(request, chain, decision);

    // The approved figure is set on FINAL approval only, and is clamped to the
    // candidate that was calculated when the request was raised: approving is
    // a decision about earned overtime, not a way to create it.
    const approvedOt =
      next.status === REQUEST_STATUS.APPROVED
        ? Math.max(0, Math.trunc(Number(request.candidate_ot_minutes) || 0))
        : null;

    // Whatever the outcome, the date's stored calculation is about to be stale:
    // an approval adds a punch and unlocks OT, a rejection ends the pending
    // state that was holding the date out of payroll. Compute the corrected
    // day NOW, with this decision assumed, so it can be committed with it.
    const [correctedDay] = await attendanceCalculationUsecase.calculateRange({
      employee_id: request.requested_for_employee_id,
      from_date: request.attendance_date,
      to_date: request.attendance_date,
      assume: {
        attendance_approval_request_id: Number(request_id),
        attendance_date: request.attendance_date,
        status: next.status,
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

    // AFTER the commit, and deliberately outside it: a rejection can leave a
    // date whose overtime is real and unasked-for, and queueing it makes
    // nothing payable, so it is not part of what has to move atomically.
    // It is NOT allowed to fail the call: the decision is already committed,
    // and reporting an error for work that succeeded would have an approver
    // click again on a request that no longer needs it. The failure is
    // returned rather than swallowed, so it is visible to whoever is looking.
    let ot_queue = null;
    if (correctedDay) {
      ot_queue = await syncOtQueueSafely({
        employee_id: Number(request.requested_for_employee_id),
        days: [correctedDay],
      });
    }

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
      ot_queue,
    };
  };

  /**
   * Run the OT auto-queue without letting it fail the work that already
   * succeeded.
   *
   * Both callers - a committed approval and a stored recalculation - have
   * already done the thing that mattered by the time this runs. Queueing an
   * approval request makes nothing payable, so a failure here is a missing
   * convenience rather than a corrupt state, and it must not be reported as a
   * failure of the decision or the recalculation.
   *
   * The error is RETURNED, not swallowed: it appears on the response as
   * `ot_queue.error` and is logged, so a date that should have been queued and
   * was not is visible rather than quietly absent.
   */
  const syncOtQueueSafely = async ({ employee_id, days }) => {
    try {
      return await otAutoQueue.syncDays({ employee_id, days });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.ATTENDANCE_REGULARIZATION",
        code: "USECASE.ATTENDANCE_REGULARIZATION.OT-AUTO-QUEUE",
        description: err.toString(),
        category: "",
        ref: { employee_id, dates: (days || []).map((d) => d && d.attendance_date) },
      });
      return { created: [], superseded: [], skipped: [], error: err.message };
    }
  };

  /* ------------------------------------------------ the OT auto-queue (#6) */

  /**
   * Whether a calculated day is one whose overtime may be queued at all.
   *
   * COMPLETE AND VALID, both. A day with an odd punch count is not complete -
   * its overtime is a guess until the missing punch is supplied, and that is a
   * regularization request, not an OT one. A day with no resolvable shift has
   * no numbers to queue. Everything else with candidate overtime on it is a
   * day somebody worked late on and has not been asked about.
   */
  const isQueueableOtDay = (day) =>
    !!day &&
    !!day.shift_snapshot &&
    day.punch_count > 0 &&
    day.punch_count % 2 === 0 &&
    (day.status === CALC_STATUS.FINAL || day.status === CALC_STATUS.OT_PENDING);

  /**
   * Keep the approval queue in step with what the engine last calculated
   * (review fix #6).
   *
   * IDEMPOTENT, which is the whole point. A recalculation that runs twice must
   * not raise two requests for the same date, so every date is checked against
   * the requests that already exist for it - PENDING, APPROVED or REJECTED
   * alike - and only a date with none of them gets one. A retry therefore
   * changes nothing.
   *
   * SAFE WHEN THE OVERTIME GOES AWAY. If a later recalculation finds no
   * candidate OT on a date whose only request is one this queue raised itself
   * and nobody has decided yet, that request is CANCELLED with its steps
   * stamped SKIPPED - superseded, auditably, rather than left sitting in
   * somebody's queue as payable overtime that no longer exists.
   *
   * A DATE WITH A MISSING PUNCH IS NOT THIS QUEUE'S BUSINESS. Its overtime
   * rides on the single combined REGULARIZATION_WITH_OT request that the
   * missing punch raises, which carries the OT the proposed punch creates.
   */
  /**
   * Raise the OT request for a day the caller has ALREADY calculated.
   *
   * It takes the day rather than re-deriving it, deliberately. `raiseRequest`
   * recalculates the date from the database on purpose - a person raising a
   * request must be held to what the engine says right now, not to what a
   * screen believed a while ago - but the auto-queue's caller has just
   * calculated that very day and is the reason it is being asked about. Going
   * back to the database would do the same work twice and, worse, would read a
   * state that the caller's own in-flight decision has not finished producing.
   *
   * The employee is both the subject and the nominal requester of their own
   * routine overtime: the chain is theirs, and `listPendingFor` already
   * excludes a requester from their own queue, so nobody is ever shown their
   * own automatic request to decide.
   */
  const createOtRequestForDay = async ({ employee_id, day }) => {
    const identity = await resolveIdentity(Number(employee_id));
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

    const candidate = Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0));
    const created = await attendanceRegularizationRepo.createRequest({
      request: {
        request_type: REQUEST_TYPE.OT,
        requested_for_employee_id: Number(employee_id),
        requested_by_employee_id: Number(employee_id),
        attendance_date: day.attendance_date,
        outlet_id: identity.outlet_id,
        requester_class: identity.requester_class,
        reason: `Automatic: ${candidate} minutes of overtime calculated for ${day.attendance_date}`,
        candidate_ot_minutes: candidate,
        auto_created: true,
      },
      chain,
      punch: null,
    });

    return { ...created, attendance_date: day.attendance_date, candidate_ot_minutes: candidate, chain };
  };

  const otAutoQueue = {
    syncDays: async ({ employee_id, days }) => {
      const candidates = (days || []).filter((day) => day && day.attendance_date);
      if (candidates.length === 0) return { created: [], superseded: [], skipped: [] };

      const dates = candidates.map((day) => day.attendance_date);
      const existing = await attendanceRegularizationRepo.findRequestsForDates(
        Number(employee_id),
        dates
      );
      const byDate = new Map();
      (existing || []).forEach((row) => byDate.set(toDateOnly(row.attendance_date), row));

      const created = [];
      const superseded = [];
      const skipped = [];

      for (const day of candidates) {
        const date = day.attendance_date;
        const request = byDate.get(date) || null;
        const wantsOt = isQueueableOtDay(day) && Number(day.candidate_ot_minutes || 0) > 0;

        if (request && !wantsOt) {
          // The overtime has gone. Only THIS queue's own undecided request may
          // be withdrawn; anything a human raised or decided is left alone.
          if (
            Number(request.auto_created) === 1 &&
            request.status === REQUEST_STATUS.PENDING &&
            request.request_type === REQUEST_TYPE.OT
          ) {
            /* eslint-disable no-await-in-loop */
            const cancelled = await attendanceRegularizationRepo.cancelAutoOtRequest({
              requestId: Number(request.attendance_approval_request_id),
              reason: `Superseded: a recalculation on ${date} found no overtime`,
            });
            /* eslint-enable no-await-in-loop */
            if (cancelled.code === 200) {
              superseded.push({ attendance_date: date, ...cancelled });
              continue;
            }
          }
          skipped.push({ attendance_date: date, why: "EXISTING_REQUEST" });
          continue;
        }

        if (!wantsOt) continue;
        if (request) {
          skipped.push({ attendance_date: date, why: "EXISTING_REQUEST" });
          continue;
        }

        /* eslint-disable no-await-in-loop */
        const raised = await createOtRequestForDay({ employee_id: Number(employee_id), day });
        /* eslint-enable no-await-in-loop */
        created.push({
          attendance_date: date,
          attendance_approval_request_id: raised.attendance_approval_request_id,
          candidate_ot_minutes: raised.candidate_ot_minutes,
        });
      }

      return { created, superseded, skipped };
    },
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
    createOtRequestForDay,
    otAutoQueue,
    syncOtQueueSafely,
    isQueueableOtDay,
    decide,
    listPending,
    listForEmployee,
    getRequest,
  };
};
