const { isPresentAbsentOnly } = require("../utils/attendance_calculation_mode");
const { permissionNotApplicableError, PERMISSION_NOT_APPLICABLE_MESSAGE } = require("../utils/attendance_permission");
const crypto = require("crypto");
const logger = require("../utils/logger");
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
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");
const { payrollLockedActionError } = require("../utils/attendance_payroll_lock");
const shiftChangeEligibility = require("../utils/shift_change_eligibility");
const shiftChangeBlock = require("../utils/shift_change_block");
const { partitionClosedDays, endOfIstDay } = require("../utils/attendance_persist_guard");

/** MySQL's TINYINT(1), a JS boolean and a string "1" all mean the same thing. */
const tinyBool = (value) => value === true || Number(value) === 1;

/** The first and last day of the calendar month a `YYYY-MM-DD` date is in. */
function monthBounds(date) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${date.slice(0, 7)}-01`, `${date.slice(0, 7)}-${String(last).padStart(2, "0")}`];
}
const { istToday, istDateOf } = require("../utils/istDate");
const {
  PERMISSION_CLOSURE_LABEL,
  resolvePermissionWindows,
  permissionForDisplay,
} = require("../utils/attendance_permission");

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
 * OT ENTERS APPROVAL AUTOMATICALLY - NOBODY REQUESTS IT (`syncAutoOt`). The
 * engine calculates `candidate_ot_minutes`; whenever a closed, complete day
 * has eligible OT, the system raises (or updates) that date's PENDING OT
 * request itself and the approver decides it from DnDS or Telegram. Employees
 * no longer request OT: the web and Telegram request endpoints are retired,
 * and `raiseOtRequest` stays only so the rules it encodes remain tested.
 * Approval is after the work, and the approved figure is clamped to the
 * eligible OT as calculated at the moment of final approval, so it can never
 * exceed what the engine says.
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
 *
 * NO DAY ROW IS WRITTEN FOR AN ATTENDANCE DAY THAT HAS NOT CLOSED
 * (`utils/attendance_persist_guard.js`, the same rule recalculation obeys).
 * What that means per path:
 *   - a regularization on a shift that needs no approval is auto-approved
 *     only once the day has closed; before that the raise is refused;
 *   - OT can be requested, and any regularization or OT finally approved,
 *     only once the day has closed; earlier stages and rejections are fine;
 *   - a SHIFT_CHANGE may be finally approved for an open or future date: the
 *     approval and its override commit, with no day row, and the date reads
 *     live under the approved shift until it closes and is recalculated.
 */

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

/**
 * How far back a date may be regularized. A month of slack, not a decade.
 *
 * DEFINED IN `utils/shift_change_eligibility.js` AND IMPORTED HERE, so the
 * window this file enforces and the window the Shift Change Eligibility
 * report prints as a reason are the same number rather than two 45s that
 * somebody has to remember to change together.
 */
const { MAX_BACKDATE_DAYS, MAX_FORWARD_DAYS } = shiftChangeEligibility;

/**
 * `approverSetupRepo` is the EMPLOYEE-LEVEL approver store (Attendance
 * Approver Setup). It is optional: without it every request follows the role
 * chain exactly as before, which is also what happens for an employee who has
 * no active mapping yet. With it, `resolveChain` snapshots the mapped approver
 * ids onto the request at creation. ONE chain per request, never a mix.
 */
module.exports = (
  attendanceRegularizationRepo,
  attendanceCalculationUsecase,
  approverSetupRepo = null,
  /**
   * THE HR BLOCK LEDGER, OPTIONAL BY CONSTRUCTION.
   *
   * Without it every path behaves exactly as it did before this feature - no
   * block is ever found, so nothing is ever blocked. That is what lets the
   * existing suites build this usecase with three arguments and keep passing,
   * and it means a deployment that has the code but not the table degrades to
   * the old behaviour rather than to an exception.
   */
  shiftChangeBlockRepo = null
) => {
  /**
   * HAS THIS DAY'S ATTENDANCE DAY CLOSED? Asked before anything here settles a
   * decision into a stored `attendance_day_calculation` row.
   *
   * The calculation usecase answers it - the same `utils/attendance_persist_guard.js`
   * rule, at the same clock, that decides whether a recalculation may store a
   * date - so there is ONE definition of an open day. A collaborator that
   * predates that method (older fakes) is answered by the same guard directly:
   * the given instant, else the last minute of a pinned business date, else
   * the clock.
   */
  const dayStateOf = (day, { now = null, today = null } = {}) => {
    if (typeof attendanceCalculationUsecase.attendanceDayState === "function") {
      return attendanceCalculationUsecase.attendanceDayState(day, { now, today });
    }
    const instant =
      typeof now === "number" ? now : now instanceof Date ? now.getTime() : today ? endOfIstDay(today) : Date.now();
    const { closed, skipped } = partitionClosedDays({ days: day ? [day] : [], now: instant });
    if (closed.length === 1) return { closed: true, reason: null, closes_at: null };
    const entry = skipped[0] || { reason: "DAY_OPEN", closes_at: null };
    return { closed: false, reason: entry.reason, closes_at: entry.closes_at };
  };

  /** Re-persist the month a committed change touched; reports, never throws. */
  const refreshMonthAfter = async (employeeId, date, now) =>
    typeof attendanceCalculationUsecase.refreshPersistedMonth === "function"
      ? attendanceCalculationUsecase.refreshPersistedMonth({ employee_id: employeeId, attendance_date: date, now })
      : { refreshed: false, reason: "NOT_WIRED" };

  /**
   * THE MONTHLY SUMMARY, KEPT IN STEP AFTER ANY COMMITTED DECISION THAT WROTE
   * A DAY - every request type, not only Permission. See
   * `attendanceCalculationUsecase.refreshAffectedMonths`.
   *
   * `collector`, when a bulk action passes one, defers the refresh: the
   * entries are gathered and the bulk action refreshes each employee/month
   * once at the end, however many of its requests touched it.
   */
  const refreshMonthsAfter = async (entries, { now = null, collector = null, source = null } = {}) => {
    if (Array.isArray(collector)) {
      collector.push(...entries);
      return { deferred: true };
    }
    if (typeof attendanceCalculationUsecase.refreshAffectedMonths === "function") {
      return attendanceCalculationUsecase.refreshAffectedMonths(entries, { now, source });
    }
    return { refreshed: 0, failed: 0, months: [], reason: "NOT_WIRED" };
  };

  /** The refusal every "not until the day closes" rule answers with. */
  const dayOpenError = (message) => {
    const err = validationError(message);
    err.code = "ATTENDANCE_DAY_OPEN";
    return err;
  };
  const closesPhrase = (state) => (state && state.closes_at ? ` (it closes at ${state.closes_at})` : "");

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
      // Named, because the Telegram message states the outlet and an id is
      // not something an approver can read.
      outlet_name: row.outlet_name || null,
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
   * THE FIRST-APPROVER NOTIFIER, set by `server.js` after both exist.
   *
   * Optional, and deliberately reachable from ONE place: the moment a shift
   * change request is created. `decide` does not hold it and cannot call it,
   * which is how "only the first approver is messaged" is a property of the
   * code rather than a rule somebody has to remember - a later stage has no
   * path to a message at all.
   */
  let shiftChangeNotifier = null;
  const setShiftChangeNotifier = (notifier) => {
    shiftChangeNotifier = notifier || null;
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
  /**
   * NO REQUEST FOR A DATE OUTSIDE THE EMPLOYMENT PERIOD. A date before the
   * joining date (`NOT_JOINED`) or after the last working date (`EXITED`) is
   * not an attendance day: there is no punch to correct, no shortage to
   * excuse, no overtime and no shift to change on it. Both bounds are the
   * columns payroll's `available_from` / `available_to` are built from.
   * Existing requests are untouched - this only refuses new ones.
   */
  const assertEmployedOn = async (employeeId, date, what) => {
    let window = null;
    if (typeof attendanceCalculationUsecase.employmentWindowFor === "function") {
      window = await attendanceCalculationUsecase.employmentWindowFor(employeeId);
    } else if (typeof attendanceCalculationUsecase.joiningDateFor === "function") {
      window = { joined_on: await attendanceCalculationUsecase.joiningDateFor(employeeId), ended_on: null };
    }
    if (!window) return;
    if (window.joined_on && date < window.joined_on) {
      throw validationError(
        `${date} is before this employee's joining date (${window.joined_on}) - ${what} cannot be raised for a date they had not joined`
      );
    }
    if (window.ended_on && date > window.ended_on) {
      throw validationError(
        `Attendance is not applicable after the employee's last working date. ${date} is after ${window.ended_on} - ${what} cannot be raised for it`
      );
    }
  };

  const raiseRequest = async ({
    actor,
    requested_for_employee_id,
    attendance_date,
    reason,
    punch_time = null,
    today = null,
    now = null,
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

    await assertEmployedOn(forEmployeeId, date, "an attendance correction");

    let open = await attendanceRegularizationRepo.findOpenRequest(forEmployeeId, date);
    // An OT the SYSTEM raised for a day that has since lost a punch (a void,
    // a late device correction) is stale, not an open question: re-sync the
    // date - which withdraws it when the live day has no eligible OT - and
    // look again.
    if (open && open.request_type === REQUEST_TYPE.OT && tinyBool(open.auto_created)) {
      await syncAutoOtSafely({ employee_id: forEmployeeId, dates: [date], now, today, source: "REGULARIZATION_RAISE" });
      open = await attendanceRegularizationRepo.findOpenRequest(forEmployeeId, date);
    }
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

    // PRESENT/ABSENT ONLY: presence is any punch at all, so no punch is ever
    // "missing" and there is nothing for a correction to complete.
    if (day && isPresentAbsentOnly(day.attendance_calculation_mode)) {
      throw validationError(
        `${date} is calculated as Present/Absent Only for this employee: there is no missing punch to regularize`
      );
    }
    if (!day || !day.shift_snapshot) {
      throw validationError(
        `${date} has no work shift resolved for this employee, so there is nothing to calculate yet`
      );
    }

    // THE SHIFT'S REGULARIZATION POLICY, read live. A repository without the
    // reader (older fakes) has no policy to enforce.
    const policy = attendanceRegularizationRepo.getRegularizationPolicy
      ? await attendanceRegularizationRepo.getRegularizationPolicy(day.shift_snapshot.work_shift_id)
      : null;
    if (policy && !tinyBool(policy.regularization_allowed)) {
      throw validationError(
        `Regularization is not allowed on work shift ${day.shift_snapshot.shift_code || day.shift_snapshot.work_shift_id}`
      );
    }
    if (policy && tinyBool(policy.regularization_require_existing_punch) && day.punch_count === 0) {
      throw validationError(
        `${date} has no punch at all, and this work shift allows a regularization only where a clock-in or clock-out already exists`
      );
    }
    if (policy && tinyBool(policy.regularization_control_enabled)) {
      const limit = Number(policy.regularization_limit_per_month);
      if (Number.isFinite(limit) && limit > 0 && attendanceRegularizationRepo.countRegularizationsInMonth) {
        const [monthStart, monthEnd] = monthBounds(date);
        const used = await attendanceRegularizationRepo.countRegularizationsInMonth(
          forEmployeeId,
          monthStart,
          monthEnd
        );
        if (used >= limit) {
          throw validationError(
            `The regularization limit of ${limit} per month is already used for ${date.slice(0, 7)} (${used} raised)`
          );
        }
      }
    }
    const requiresApproval = !policy || tinyBool(policy.regularization_requires_approval);

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
    let { chain, source: chain_source } = await resolveChain(identity);

    // NO APPROVAL REQUIRED: the punch takes effect as it is raised. The chain
    // collapses to one already-decided ADMIN stage (the audit row that says
    // who, when and why), and the corrected day - the same engine run over
    // raw punches plus this one, with the approval assumed - is stored in the
    // same transaction, exactly as a final approval would store it.
    let auto_approve = null;
    if (!requiresApproval) {
      // AN AUTO-APPROVAL IS A FINAL SETTLEMENT, so it waits for the day to
      // close. On an open day an odd punch count is not yet a MISSING punch -
      // the employee may simply not have punched out - and settling it now
      // would store a half-finished day that later reads as history. Refused,
      // with nothing written; the day keeps reading live, and the same request
      // succeeds once the attendance day has closed.
      const dayState = dayStateOf(day, { now, today });
      if (!dayState.closed) {
        throw dayOpenError(
          `${date} is still open${closesPhrase(dayState)}. This work shift auto-approves regularizations, ` +
            "so a missing punch can be regularized once the attendance day has closed - until then the day " +
            "is shown live and a punch that arrives will still count."
        );
      }
      chain = [{ stage_no: 1, approver_role: APPROVER_ROLE.ADMIN, outlet_id: null }];
      chain_source = "SHIFT_POLICY_NO_APPROVAL";
      const [correctedDay] = await attendanceCalculationUsecase.calculateRange({
        employee_id: forEmployeeId,
        from_date: date,
        to_date: date,
        assume: {
          attendance_date: date,
          request_type: REQUEST_TYPE.REGULARIZATION,
          status: REQUEST_STATUS.APPROVED,
          candidate_ot_minutes: 0,
          reason: reason.trim(),
          approved_ot_minutes: 0,
          regularized_punch: { punch_id: null, io_time: punchTime },
        },
      });
      auto_approve = {
        remarks: "Auto-approved: the work shift does not require approval",
        calculations: correctedDay ? [attendanceCalculationUsecase.toStorageRow(correctedDay)] : [],
      };
    }

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
      auto_approve,
    });

    // An auto-approved request wrote its corrected day in the same commit.
    const monthRefresh =
      auto_approve && auto_approve.calculations.length > 0 && created && (!created.code || created.code === 200)
        ? await refreshMonthsAfter([{ employee_id: forEmployeeId, attendance_date: date }], {
            now,
            source: "an auto-approved regularization",
          })
        : null;

    return {
      ...created,
      month_refresh: monthRefresh,
      status: created.status || REQUEST_STATUS.PENDING,
      auto_approved: Boolean(auto_approve),
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
  const raiseOtRequest = async ({ actor, attendance_date, reason, today = null, now = null }) => {
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

    await assertEmployedOn(employeeId, date, "an OT request");

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
    // PRESENT/ABSENT ONLY calculates no overtime from punches, by design.
    if (day && isPresentAbsentOnly(day.attendance_calculation_mode)) {
      throw validationError(
        `${date} is calculated as Present/Absent Only for this employee, which calculates no overtime - there is nothing to request`
      );
    }
    if (!day || !day.shift_snapshot) {
      throw validationError(`${date} has no work shift resolved, so there is no overtime to request`);
    }
    // NOT BEFORE THE DAY CLOSES. `date <= today` is not enough: today, and
    // under an overnight cutoff yesterday, can still be taking punches, and a
    // day that looks FINAL with an even punch count at 18:00 can gain two more
    // before its cutoff. Overtime is claimed against the finished day.
    const dayState = dayStateOf(day, { now, today });
    if (!dayState.closed) {
      throw dayOpenError(
        `${date}'s attendance day is still open${closesPhrase(dayState)}, so its overtime cannot be requested yet`
      );
    }
    if (day.is_final !== true || day.status !== CALC_STATUS.FINAL || day.punch_count % 2 === 1) {
      throw validationError(
        `${date} is not a complete attendance day yet, so its overtime cannot be requested`
      );
    }
    /*
     * WHAT MAY BE CLAIMED IS NOT ALWAYS THE WHOLE CANDIDATE.
     *
     * On a date whose shift came from an approved SHIFT_CHANGE request, the
     * overtime that shift produced is already authorised by that approval -
     * asking the employee to request it again would be asking twice for one
     * decision, and approving it again would risk paying one minute through
     * two records. Only the EXCESS, earned outside the approved shift's own
     * window, still needs a request.
     *
     * `excess_ot_minutes` is the engine's figure and equals the whole
     * candidate on every ordinary date, so nothing changes for them.
     */
    const claimable =
      day.excess_ot_minutes === undefined || day.excess_ot_minutes === null
        ? Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0))
        : Math.max(0, Math.trunc(Number(day.excess_ot_minutes) || 0));
    const authorised = Math.max(0, Math.trunc(Number(day.shift_authorised_ot_minutes) || 0));
    const candidate = claimable;
    if (candidate <= 0) {
      if (authorised > 0) {
        throw validationError(
          `${date} is covered by an approved shift change, which already authorises its ${authorised} overtime minute(s) - there is nothing left to request`
        );
      }
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

    /**
     * THE RACE, LOST. `createRequest` takes the shared employee lock and
     * re-reads the block inside its own transaction, so it - not the check
     * above - is what actually guarantees a request and a block cannot both
     * appear. When it reports one, nothing was inserted and the employee is
     * told exactly what they would have been told had HR committed a moment
     * earlier: the same sentence, from the same shared helper.
     */
    if (created && created.hr_blocked) {
      throw validationError(
        shiftChangeBlock.blockMessage({
          attendance_date: date,
          reason: created.block ? created.block.reason : null,
        })
      );
    }

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

  /** "MORN 06:00-14:00", or the code alone when the times are unknown. */
  const shiftLabel = (shift) => {
    if (!shift) return null;
    const name = shift.shift_code || shift.shift_name || null;
    if (!shift.in_time || !shift.out_time) return name;
    // HH:MM. The seconds a TIME column carries are noise in a message an
    // approver reads on a phone.
    const hhmm = (t) => String(t).slice(0, 5);
    return `${name ? `${name} ` : ""}${hhmm(shift.in_time)}-${hhmm(shift.out_time)}`;
  };

  /**
   * THE EMPLOYEE'S ONE-DAY SHIFT CHANGE REQUEST.
   *
   * It is a REQUEST and never a change. Nothing this function writes makes any
   * shift effective: the row it creates is PENDING, the resolver reads no
   * pending request, and the only thing that ever writes an
   * `attendance_date_shift_override` is the FINAL approval in `decide`. The
   * employee's permanent shift, their salary master and every other date are
   * untouched by it, now and after approval.
   *
   * IT IS FOR YOURSELF ONLY, and that is enforced by construction rather than
   * by a check: the employee is `actor.employee_id`, taken from the session,
   * and there is no parameter for anybody else.
   *
   * ================================== WHY A LONGER SHIFT, AND ONLY LONGER ===
   *
   * The requested shift's NRM must be GREATER than the employee's own for the
   * date. The feature exists so somebody can cover a longer day than their
   * roster - and because regular time is paid against the BASE NRM whatever
   * shift the day is calculated under (see `utils/attendance_engine.js`), a
   * SHORTER requested shift would not reduce what they are owed by a minute:
   * it would only move the expected in and out, quietly forgiving a late
   * arrival and an early finish while the entitlement stayed where it was.
   * Reducing somebody's hours is a roster decision and belongs to Edit Shift
   * Assignment, which is dated, audited and needs a management permission.
   * The rule is enforced here, on the server; the screen filtering the
   * dropdown is a convenience and is not trusted.
   */
  const raiseShiftChangeRequest = async ({
    actor,
    attendance_date,
    work_shift_id,
    reason,
    today = null,
  }) => {
    const employeeId = Number(actor && actor.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("An employee identity is required to request a shift change");
    }
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");

    const requestedShiftId = Number(work_shift_id);
    if (!Number.isInteger(requestedShiftId) || requestedShiftId <= 0) {
      throw validationError("work_shift_id is required and must be a work shift id");
    }
    if (typeof reason !== "string" || reason.trim().length < 5) {
      throw validationError("A reason of at least 5 characters is required");
    }

    const businessToday = istToday(today);

    await assertEmployedOn(employeeId, date, "a shift change request");

    // The Attendance Calculation Type FOR THIS DATE, resolved first: on a
    // Present/Absent Only date the request is refused whatever else is true.
    const attendanceMode = await attendanceModeFor(employeeId, date);

    /**
     * EVERY REFUSAL BELOW IS `utils/shift_change_eligibility.js#decidePreconditions`,
     * AND NOT A TEST WRITTEN HERE.
     *
     * It is the SAME function the Shift Change Eligibility report calls for
     * its "Can Raise Shift Change?" column, so a date HR is told is raisable
     * is a date this function accepts, and a No in the report carries the
     * very sentence the employee would have been shown. The rule cannot drift
     * between the two screens because there is only one copy of it.
     *
     * It is called as each fact becomes known rather than once at the end:
     * the reads are ordered so an out-of-window date still costs nothing, and
     * a pure decision function evaluated on a prefix of the facts returns the
     * same first refusal it would on all of them.
     */
    const gate = (facts) => {
      const blocked = shiftChangeEligibility.decidePreconditions({
        attendance_date: date,
        today: businessToday,
        attendance_calculation_mode: attendanceMode,
        ...facts,
      });
      if (!blocked) return;
      // The payroll lock keeps its own error SHAPE - callers branch on it and
      // the response carries the locked periods - while the rule that decided
      // it stays in the shared file with the others.
      if (blocked.reason_code === shiftChangeEligibility.SHIFT_CHANGE_REASON.PAYROLL_LOCKED) {
        throw payrollLockedActionError(blocked.payroll_locked, "A shift change for this date");
      }
      throw validationError(blocked.reason);
    };

    gate({});

    // PAYROLL LOCK, BEFORE THE REQUEST EXISTS. A date in a settled month can
    // no longer be recalculated by anybody, so a request for it could never
    // be approved; letting it be filed would only put a row in the queue that
    // has to be rejected by hand.
    let locked = [];
    if (typeof attendanceCalculationUsecase.findPayrollLockedPeriods === "function") {
      locked = await attendanceCalculationUsecase.findPayrollLockedPeriods([
        { employee_id: employeeId, attendance_date: date },
      ]);
    }
    gate({ payroll_locked: locked });

    const identity = await resolveIdentity(employeeId);

    // ONE OPEN OR APPROVED SHIFT REQUEST PER DATE. The database's unique key
    // refuses a second OPEN one whatever happens here; this refuses the
    // already-decided cases too, and says which.
    const existing = await attendanceRegularizationRepo.findRequestsForDates(employeeId, [date]);
    const priorShift = (existing || []).find((r) => r.request_type === REQUEST_TYPE.SHIFT_CHANGE);
    gate({ payroll_locked: locked, existing_request: priorShift || null });

    /**
     * THE HR BLOCK, ENFORCED HERE AND NOT ONLY ON A SCREEN.
     *
     * This is the authoritative gate: the web form, the Telegram Mini App and
     * a hand-made API call all arrive at this function, so a block that is
     * only a hidden button is not a block at all.
     *
     * IT SITS AFTER THE PAYROLL LOCK AND THE EXISTING-REQUEST CHECK ON
     * PURPOSE. A locked month and an already-pending request are facts HR
     * cannot change by blocking, and reporting "HR blocked this date" over
     * either would hide the reason the date is really closed. The block only
     * ever speaks when the system would otherwise have said yes - which is
     * exactly what `effectiveVerdict` encodes, and why the composition lives
     * in the shared file rather than being spelled out again here.
     */
    const activeBlock = await activeBlockFor(employeeId, date);
    if (shiftChangeBlock.isActive(activeBlock)) {
      throw validationError(
        shiftChangeBlock.blockMessage({ attendance_date: date, reason: activeBlock.reason })
      );
    }

    // The two shifts, resolved through the calculation's own resolver on the
    // configuration version in force for that date.
    const resolved = await attendanceCalculationUsecase.shiftForDate({
      employee_id: employeeId,
      attendance_date: date,
      work_shift_id: requestedShiftId,
    });

    gate({
      payroll_locked: locked,
      existing_request: priorShift || null,
      base_work_shift_id:
        resolved.base.work_shift_id === null || resolved.base.work_shift_id === undefined
          ? null
          : Number(resolved.base.work_shift_id),
    });

    if (Number(resolved.base.work_shift_id) === requestedShiftId) {
      throw validationError(`That is already your shift for ${date}`);
    }
    // ONLY AN ACTIVE SHIFT, as the dropdown offers. `shiftChangeOptions`
    // builds its list from the active shifts alone, so without this a
    // hand-made request could name a retired shift the screen never showed -
    // the two paths would disagree about the very rule they share.
    if (typeof attendanceCalculationUsecase.listDateShiftOptions === "function") {
      const listed = await attendanceCalculationUsecase.listDateShiftOptions();
      const active = Array.isArray(listed) ? listed : (listed && listed.data) || [];
      if (!active.some((s) => Number(s.work_shift_id) === requestedShiftId)) {
        throw validationError("That work shift is not active, so it cannot be requested");
      }
    }
    if (resolved.work_shift_id === null || resolved.nrm_minutes === null) {
      throw validationError(`That work shift has no schedule for ${date}`);
    }
    if (!resolved.is_working_day) {
      throw validationError(`That work shift does not run on ${date}`);
    }

    const requestedNrm = Number(resolved.nrm_minutes);
    const baseNrm = Number(resolved.base.nrm_minutes);
    // THE LONGER-ONLY RULE, from the shared file. The report asks whether ANY
    // shift would satisfy it; this asks whether the ONE the employee named
    // does. Same predicate, same sentence, one place.
    if (
      !shiftChangeEligibility.hasLongerShiftOption({
        base_nrm_minutes: baseNrm,
        candidates: [{ is_working_day: resolved.is_working_day, nrm_minutes: requestedNrm }],
      })
    ) {
      throw validationError(
        shiftChangeEligibility.REASON_TEXT[
          shiftChangeEligibility.SHIFT_CHANGE_REASON.NO_LONGER_SHIFT
        ]
      );
    }

    const { chain, source: chain_source } = await resolveChain(identity);
    const created = await attendanceRegularizationRepo.createRequest({
      request: {
        request_type: REQUEST_TYPE.SHIFT_CHANGE,
        requested_for_employee_id: employeeId,
        requested_by_employee_id: employeeId,
        attendance_date: date,
        outlet_id: identity.outlet_id,
        requester_class: identity.requester_class,
        reason: reason.trim(),
        candidate_ot_minutes: 0,
        auto_created: false,
        chain_source,
        requested_work_shift_id: requestedShiftId,
        // The permanent shift AS RESOLVED NOW, snapshotted onto the request:
        // it is what the approver is shown, what the override records as the
        // shift it stood in for, and it must not silently change if the
        // roster moves while the request is in the queue.
        base_work_shift_id: Number(resolved.base.work_shift_id),
      },
      chain,
      punch: null,
    });

    // TELEGRAM, TO THE FIRST APPROVER, ONCE. It never throws into this
    // function: the request is created and committed, and a Telegram outage
    // must not undo an employee's submission or hide it from the web queue.
    let telegramNotification = { sent: false, reason: "NO_NOTIFIER_WIRED" };
    if (shiftChangeNotifier && typeof shiftChangeNotifier.notifyFirstApprover === "function") {
      telegramNotification = await shiftChangeNotifier.notifyFirstApprover({
        attendance_approval_request_id: created.attendance_approval_request_id,
        employee_id: employeeId,
        employee_name: identity.employee_name,
        outlet_id: identity.outlet_id,
        outlet_name: identity.outlet_name || null,
        attendance_date: date,
        base_shift_label: shiftLabel(resolved.base),
        requested_shift_label: shiftLabel(resolved),
        reason: reason.trim(),
        chain,
      });
    }

    return {
      ...created,
      request_type: REQUEST_TYPE.SHIFT_CHANGE,
      attendance_date: date,
      telegram: telegramNotification,
      requested_work_shift_id: requestedShiftId,
      requested_shift_code: resolved.shift_code,
      requested_shift_name: resolved.shift_name,
      requested_nrm_minutes: requestedNrm,
      base_work_shift_id: Number(resolved.base.work_shift_id),
      base_shift_code: resolved.base.shift_code,
      base_shift_name: resolved.base.shift_name,
      base_nrm_minutes: baseNrm,
      chain,
      chain_source,
      requester_class: identity.requester_class,
      requester_class_is_default: identity.requester_class_is_default,
    };
  };

  /**
   * Raise a PERMISSION request: leave early, come in late, or be away for a
   * period of ONE date's shift, without a salary deduction for it - if the
   * approval chain agrees.
   *
   * For YOURSELF, or - with `raise_attendance_permission_for_others`, checked
   * by the route together with the employee's outlet scope - for an employee.
   * Either way it walks the employee's ordinary attendance approval chain:
   * the same `resolveChain`, the same `canApprove` (nobody decides a request
   * they raised or are the subject of), the same payroll lock and the same
   * revoke path as every other attendance request.
   *
   * The windows are CLOCK TIMES inside the date's resolved shift - or "from
   * a time to the scheduled shift end" - and are refused if they reach
   * outside it, overlap each other, cover the whole shift (that is leave) or
   * overlap a live permission already on the date. What is stored is the
   * window as approved; what it COVERS is decided by the engine on every
   * calculation, and only ever the chargeable shortage inside it.
   *
   * Refused: a date in a payroll-locked month, outside the request window
   * (the same backdate / forward limits as a shift request), with no working
   * shift, for an employee who is not required to punch, or with a PERMISSION
   * request already pending on it.
   */
  const raisePermissionRequest = async ({
    actor,
    requested_for_employee_id = null,
    attendance_date,
    windows,
    reason,
    remarks = null,
    today = null,
  }) => {
    const actorId = Number(actor && actor.employee_id);
    if (!Number.isInteger(actorId) || actorId <= 0) {
      throw validationError("An employee identity is required to request a permission");
    }
    const forId =
      requested_for_employee_id === null || requested_for_employee_id === undefined
        ? actorId
        : Number(requested_for_employee_id);
    if (!Number.isInteger(forId) || forId <= 0) {
      throw validationError("requested_for_employee_id must be an employee id");
    }
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 5) throw validationError("A reason of at least 5 characters is required");
    if (why.length > 500) throw validationError("A reason may be at most 500 characters");

    const businessToday = istToday(today);
    if (date < addDays(businessToday, -MAX_BACKDATE_DAYS)) {
      throw validationError(`A permission can be requested for at most ${MAX_BACKDATE_DAYS} days back`);
    }
    if (date > addDays(businessToday, MAX_FORWARD_DAYS)) {
      throw validationError(`A permission can be requested at most ${MAX_FORWARD_DAYS} days ahead`);
    }

    await assertEmployedOn(forId, date, "a permission request");

    // PAYROLL LOCK, BEFORE THE REQUEST EXISTS - a permission against a
    // settled month could never be approved.
    if (typeof attendanceCalculationUsecase.findPayrollLockedPeriods === "function") {
      const locked = await attendanceCalculationUsecase.findPayrollLockedPeriods([
        { employee_id: forId, attendance_date: date },
      ]);
      if (locked.length > 0) throw payrollLockedActionError(locked, "A permission for this date");
    }

    // PRESENT/ABSENT ONLY ON THIS DATE: nothing is short, so a permission
    // is not applicable. Said before the shift is read, so the answer is the
    // same with or without a shift. The insert guard refuses it again inside
    // the write's transaction - that one no race gets past.
    if (isPresentAbsentOnly(await attendanceModeFor(forId, date))) throw permissionNotApplicableError();

    const shift = await attendanceCalculationUsecase.shiftForDate({ employee_id: forId, attendance_date: date });
    if (shift && shift.attendance_required === false) {
      throw validationError("This employee is not required to punch, so there is no shortage a permission could cover");
    }
    const resolved = resolvePermissionWindows({ attendance_date: date, shift, windows, clip: false });
    if (!resolved.ok) throw validationError(resolved.message);

    const existing = await attendanceRegularizationRepo.findRequestsForDates(forId, [date]);
    const pending = (existing || []).find(
      (r) => r.request_type === REQUEST_TYPE.PERMISSION && r.status === REQUEST_STATUS.PENDING
    );
    if (pending) {
      throw validationError(
        `A permission request for ${date} is already pending (#${pending.attendance_approval_request_id})`
      );
    }

    const identity = await resolveIdentity(forId);
    const { chain, source: chain_source } = await resolveChain(identity);
    const created = await attendanceRegularizationRepo.createRequest({
      request: {
        request_type: REQUEST_TYPE.PERMISSION,
        requested_for_employee_id: forId,
        requested_by_employee_id: actorId,
        attendance_date: date,
        outlet_id: identity.outlet_id,
        requester_class: identity.requester_class,
        reason: why,
        candidate_ot_minutes: 0,
        auto_created: false,
        chain_source,
      },
      chain,
      punch: null,
      permissions: resolved.windows.map((w) => ({
        permission_from: w.permission_from,
        permission_to: w.permission_to,
        to_shift_end: w.to_shift_end,
        permission_minutes: w.permission_minutes,
        reason: why,
        remarks: remarks ? String(remarks).trim().slice(0, 500) || null : null,
        work_shift_id: shift.work_shift_id === undefined ? null : shift.work_shift_id,
        created_by_user_id:
          actor.user_id === null || actor.user_id === undefined ? null : Number(actor.user_id),
      })),
    });
    if (created && created.permission_overlap) {
      throw validationError(
        `This window overlaps a permission already on ${date}; revoke or reject that one first`
      );
    }

    return {
      ...created,
      request_type: REQUEST_TYPE.PERMISSION,
      requested_for_employee_id: forId,
      attendance_date: date,
      windows: resolved.windows.map((w) => ({
        permission_from: w.permission_from,
        permission_to: w.permission_to,
        to_shift_end: w.to_shift_end,
        permission_minutes: w.permission_minutes,
      })),
      shift_from: resolved.shift_from,
      shift_to: resolved.shift_to,
      chain,
      chain_source,
      requester_class: identity.requester_class,
      requester_class_is_default: identity.requester_class_is_default,
    };
  };

  /**
   * THE ACTIVE HR BLOCK for an employee/date, or null when there is none.
   *
   * ONE READ, SHARED BY BOTH PATHS, so the dropdown and the submit path can
   * never disagree about whether a date is blocked. Absent the repository it
   * answers null, which is the pre-feature behaviour.
   */
  /**
   * The employee's Attendance Calculation Type on a date, from the ONE
   * effective-dated resolver the calculation uses. Absent the reader (older
   * fakes) it is undefined, which the shift change rule reads as "not read".
   */
  const attendanceModeFor = async (employeeId, date) =>
    typeof attendanceCalculationUsecase.attendanceCalculationModeFor === "function"
      ? attendanceCalculationUsecase.attendanceCalculationModeFor({ employee_id: employeeId, attendance_date: date })
      : undefined;

  const activeBlockFor = async (employeeId, date) => {
    if (!shiftChangeBlockRepo || typeof shiftChangeBlockRepo.findActive !== "function") return null;
    return shiftChangeBlockRepo.findActive(employeeId, date);
  };

  /**
   * WOULD A SHIFT CHANGE BE ALLOWED FOR THIS EMPLOYEE/DATE, RIGHT NOW?
   *
   * A READ-ONLY probe that runs the SAME gates `raiseShiftChangeRequest` runs
   * and creates nothing. It exists so the HR block screen can re-check the
   * live system verdict at write time instead of trusting a report row the
   * browser has been holding - a row that may be minutes old and may have been
   * overtaken by a payroll close or somebody else's request.
   *
   * IT ADDS NO RULE OF ITS OWN. The window, the payroll lock, the existing
   * request and the longer-shift test are `shift_change_eligibility.decide`
   * exactly as the submit path applies them; the HR block is composed on top
   * by `shift_change_block.effectiveVerdict`, never folded into the system
   * verdict, so both figures stay separately readable.
   */
  const shiftChangeEligibilityFor = async ({ employee_id, attendance_date, today = null }) => {
    const employeeId = Number(employee_id);
    const date = toDateOnly(attendance_date);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      throw validationError("employee_id is required and must be an employee id");
    }
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");

    const businessToday = istToday(today);

    let locked = [];
    if (typeof attendanceCalculationUsecase.findPayrollLockedPeriods === "function") {
      locked = await attendanceCalculationUsecase.findPayrollLockedPeriods([
        { employee_id: employeeId, attendance_date: date },
      ]);
    }

    const existing = await attendanceRegularizationRepo.findRequestsForDates(employeeId, [date]);
    const priorShift = (existing || []).find((r) => r.request_type === REQUEST_TYPE.SHIFT_CHANGE) || null;

    // The base shift and the candidate set, through the SAME options builder
    // the employee's dropdown uses - so "is there a longer shift" is answered
    // once, by `hasLongerShiftOption`, and not re-derived here.
    const offered = await shiftChangeOptions({
      actor: { employee_id: employeeId },
      attendance_date: date,
      // The options call must not apply the block itself here: this probe
      // reports the SYSTEM verdict and composes the block separately below.
      skip_block: true,
    });

    const system = shiftChangeEligibility.decide({
      attendance_date: date,
      today: businessToday,
      payroll_locked: locked,
      existing_request: priorShift,
      attendance_calculation_mode: await attendanceModeFor(employeeId, date),
      base_work_shift_id:
        offered.base && offered.base.work_shift_id !== null && offered.base.work_shift_id !== undefined
          ? Number(offered.base.work_shift_id)
          : null,
      has_longer_option: (offered.options || []).length > 0,
    });

    const block = await activeBlockFor(employeeId, date);
    const effective = shiftChangeBlock.effectiveVerdict({
      system,
      active_block: block,
      attendance_date: date,
    });

    return {
      employee_id: employeeId,
      attendance_date: date,
      system,
      active_block: block,
      effective,
      request_state: priorShift
        ? priorShift.status
        : shiftChangeBlock.REQUEST_STATE.NOT_RAISED,
      request: priorShift,
      base: offered.base,
      options: offered.options,
    };
  };

  /**
   * The shifts an employee may ASK FOR on a date: active shifts that run that
   * weekday and whose NRM is longer than their own.
   *
   * The screen uses it to offer only valid options. It is a convenience and
   * not the rule - `raiseShiftChangeRequest` re-derives every one of these
   * conditions on the server and refuses anything that fails them, so a
   * hand-made request cannot get past a filtered dropdown.
   *
   * THE LONGER-SHIFT TEST IS THE SHARED ONE, `hasLongerShiftOption`, and is
   * not written out again here. This function used to carry its own copy of
   * the predicate, which was harmless only for as long as the two agreed: a
   * dropdown that offered a shift the submit path then refused would send an
   * employee round a loop they cannot get out of, and one that HID a shift
   * the submit path would have accepted would silently deny them a
   * regularisation they were entitled to. Same helper, same conditions, one
   * place - so the options offered and the request accepted cannot drift.
   */
  const shiftChangeOptions = async ({ actor, attendance_date, skip_block = false }) => {
    const employeeId = Number(actor && actor.employee_id);
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");

    /**
     * THE BLOCK IS APPLIED HERE TOO, AND FIRST.
     *
     * The options endpoint and the submit endpoint must never disagree: a
     * dropdown that still offers three longer shifts for a date the submit
     * path will refuse sends an employee round a loop they cannot get out of,
     * and it is the screen, not the rule, that looks broken.
     *
     * So a blocked date returns NO OPTIONS and says why, in the same sentence
     * the submit path refuses with. `can_raise` is reported on every response
     * - true or false - so the caller never has to infer the answer from an
     * empty list, which could equally mean "no longer shift exists".
     *
     * `skip_block` is for ONE internal caller - `shiftChangeEligibilityFor`,
     * which needs the SYSTEM verdict on its own before composing the block on
     * top. It is not reachable from any route.
     */
    // PRESENT/ABSENT ONLY: no options at all, in the submit path's sentence.
    const attendanceMode = await attendanceModeFor(employeeId, date);
    if (isPresentAbsentOnly(attendanceMode)) {
      return {
        attendance_date: date,
        base: null,
        options: [],
        can_raise: false,
        hr_blocked: false,
        attendance_calculation_mode: attendanceMode,
        reason:
          shiftChangeEligibility.REASON_TEXT[shiftChangeEligibility.SHIFT_CHANGE_REASON.PRESENT_ABSENT_ONLY],
      };
    }

    if (!skip_block) {
      const block = await activeBlockFor(employeeId, date);
      if (shiftChangeBlock.isActive(block)) {
        return {
          attendance_date: date,
          base: null,
          options: [],
          can_raise: false,
          hr_blocked: true,
          block_reason: block.reason,
          reason: shiftChangeBlock.blockMessage({ attendance_date: date, reason: block.reason }),
        };
      }
    }

    const base = await attendanceCalculationUsecase.shiftForDate({
      employee_id: employeeId,
      attendance_date: date,
    });
    if (base.base.work_shift_id === null) {
      return {
        attendance_date: date,
        base: base.base,
        options: [],
        can_raise: false,
        hr_blocked: false,
        reason: `You have no work shift assigned for ${date}, so there is no shift to change from`,
      };
    }

    const all = await attendanceCalculationUsecase.listDateShiftOptions();
    const shifts = Array.isArray(all) ? all : (all && all.data) || [];
    const options = [];
    for (const shift of shifts) {
      const id = Number(shift.work_shift_id);
      if (id === Number(base.base.work_shift_id)) continue;
      /* eslint-disable no-await-in-loop */
      const candidate = await attendanceCalculationUsecase.shiftForDate({
        employee_id: employeeId,
        attendance_date: date,
        work_shift_id: id,
      });
      /* eslint-enable no-await-in-loop */
      // `!!` because the helper rejects only an explicit `false`, while
      // `shiftForDate` reports "no snapshot for this date" as `null` - which
      // this loop has always treated as "does not run", and still must.
      if (
        !shiftChangeEligibility.hasLongerShiftOption({
          base_nrm_minutes: base.base.nrm_minutes,
          candidates: [
            { is_working_day: !!candidate.is_working_day, nrm_minutes: candidate.nrm_minutes },
          ],
        })
      ) {
        continue;
      }
      options.push({
        work_shift_id: id,
        shift_code: candidate.shift_code,
        shift_name: candidate.shift_name,
        in_time: candidate.in_time,
        out_time: candidate.out_time,
        nrm_minutes: Number(candidate.nrm_minutes),
      });
    }
    return {
      attendance_date: date,
      base: base.base,
      options,
      // Consistent with the submit path: options exist only when a longer
      // shift exists AND no HR block applies.
      can_raise: options.length > 0,
      hr_blocked: false,
      reason:
        options.length > 0
          ? null
          : shiftChangeEligibility.REASON_TEXT[
              shiftChangeEligibility.SHIFT_CHANGE_REASON.NO_LONGER_SHIFT
            ],
    };
  };

  /**
   * ADMIN REVOKE - VOID a decided REGULARIZATION or OT request.
   *
   *   #100 OT, Final APPROVED -> revoke -> #100 CANCELLED
   *   the employee's day: NOT REQUESTED, with Request OT offered again
   *   they request again -> #101 PENDING, a new chain from its first stage
   *
   * A REVOCATION IS NOT A REOPENING. The old request never comes back to a
   * queue and its approval steps keep the decisions they were given - that
   * chain is history now, readable on the request and in the revocation
   * audit. What the employee gets back is their right to ask again, as a
   * NEW request with a new id and a fresh chain; the one-OT-claim-per-date
   * and one-open-request-per-date rules already ignore a CANCELLED request,
   * so nothing stands in the way of that.
   *
   * WHAT IT DOES TO ATTENDANCE. The day is recalculated as if the request
   * had never been made, in the revocation's own transaction:
   *   OT              no approved OT from it; the day's OT is AVAILABLE again
   *                   (Not Requested, with Request OT);
   *   REGULARIZATION  its punch stops counting; if the day is incomplete
   *                   without it, the employee may raise a fresh correction.
   * A REJECTED request changed nothing when it was rejected, and voiding it
   * changes nothing but its status - which is what frees the date for a
   * fresh request.
   *
   * WHO. An administrator - `user_type` 2 - and nobody else. The route
   * refuses everybody else first; this refuses them again.
   *
   * WHAT THE CLIENT MAY SAY. The request id and a reason (and, optionally,
   * which decided stage it is revoking - by default the stage that decided
   * the request). Everything else is read from the stored rows.
   *
   * PAYROLL LOCK, unchanged and with no override.
   *
   * SHIFT_CHANGE - the one type whose two outcomes differ:
   *
   *   APPROVED  -> CANCELLED. The approval's one-day override stops applying
   *                (the row stays as history; every reader skips an override
   *                whose request is CANCELLED), the date is recalculated on
   *                the shift that applies without it - the permanent shift,
   *                or an earlier override - and the OT that shift authorised
   *                is gone with it. REFUSED while any OT decision stands on
   *                the date (open, approved or rejected): on a shift-changed
   *                date OT is measured against the approved shift, so that
   *                claim must be revoked first and made again against the
   *                real day.
   *   REJECTED  -> REOPENED. The rejecting stage goes back to PENDING and
   *                the request resumes there, in that approver's queue;
   *                earlier approvals stand. Only where the shift request
   *                workflow would accept the request now: inside the date
   *                window, not payroll-locked, no HR block, and no other open
   *                or approved shift request for the date.
   *   PENDING   -> refused: it is still in approval.
   */
  const REVOCABLE_TYPES = [
    REQUEST_TYPE.REGULARIZATION,
    REQUEST_TYPE.REGULARIZATION_WITH_OT,
    REQUEST_TYPE.OT,
    REQUEST_TYPE.SHIFT_CHANGE,
    // PERMISSION revokes exactly as an attendance correction does: APPROVED
    // or REJECTED -> CANCELLED, and the day is recalculated without its
    // windows in the revocation's own transaction.
    REQUEST_TYPE.PERMISSION,
  ];

  const revokeDecision = async ({
    actor,
    request_id,
    stage_no = null,
    reason,
    now = null,
    month_refresh_collector = null,
  }) => {
    if (!actor || Number(actor.user_type) !== ADMIN_USER_TYPE) {
      const err = new Error("Only an administrator can revoke an approval decision");
      err.name = "ForbiddenError";
      throw err;
    }
    const requestId = Number(request_id);
    if (!Number.isInteger(requestId) || requestId <= 0) throw validationError("request_id must be a request id");
    const askedStage = stage_no === null || stage_no === undefined || stage_no === "" ? null : Number(stage_no);
    if (askedStage !== null && (!Number.isInteger(askedStage) || askedStage <= 0)) {
      throw validationError("stage_no must be a stage number");
    }
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 5) throw validationError("A revoke reason of at least 5 characters is required");
    if (why.length > 500) throw validationError("A revoke reason may be at most 500 characters");

    const snapshot = await attendanceRegularizationRepo.getRevocationSnapshot(requestId);
    if (!snapshot) throw validationError(`No such request: ${requestId}`);
    const { request, steps } = snapshot;

    if (!REVOCABLE_TYPES.includes(request.request_type)) {
      throw validationError(`A ${request.request_type} decision cannot be revoked`);
    }
    if (request.status === REQUEST_STATUS.CANCELLED) throw validationError("This request has already been revoked");
    if (request.closure_reason) {
      throw validationError(
        "This request was closed by the payroll lock, not by an approver, and cannot be revoked"
      );
    }
    const isShift = request.request_type === REQUEST_TYPE.SHIFT_CHANGE;
    if (isShift && request.status === REQUEST_STATUS.PENDING) {
      throw validationError("This shift change request is still in approval - there is no decision to revoke");
    }
    const reopen = isShift && request.status === REQUEST_STATUS.REJECTED;

    /*
     * WHICH DECISION IS BEING VOIDED. For a decided request, the stage that
     * decided it: the REJECTED step, or the last APPROVED one. A request the
     * earlier, REOPENING revoke put back in the queue has had that decision
     * cleared from its steps - it survives only in the previous revocation's
     * audit row, which is where it is read from.
     */
    const decided = (steps || []).filter(
      (st) => st.decision === STEP_DECISION.APPROVED || st.decision === STEP_DECISION.REJECTED
    );
    let stageNo;
    let originalDecision;
    if (request.status === REQUEST_STATUS.APPROVED || request.status === REQUEST_STATUS.REJECTED) {
      const deciding =
        (steps || []).find((st) => st.decision === STEP_DECISION.REJECTED) || decided[decided.length - 1] || null;
      const target =
        askedStage === null ? deciding : (steps || []).find((st) => Number(st.stage_no) === askedStage) || null;
      if (!target) throw validationError(`This request has no stage ${askedStage}`);
      if (target.decision !== STEP_DECISION.APPROVED && target.decision !== STEP_DECISION.REJECTED) {
        throw validationError(
          `Stage ${target.stage_no} has no decision to revoke - it is ${String(target.decision).toLowerCase()}`
        );
      }
      stageNo = Number(target.stage_no);
      originalDecision = target.decision;
      if (reopen && originalDecision !== STEP_DECISION.REJECTED) {
        throw validationError("A rejected shift change reopens at the stage that rejected it");
      }
    } else {
      const prior =
        typeof attendanceRegularizationRepo.getLatestRevocation === "function"
          ? await attendanceRegularizationRepo.getLatestRevocation(requestId)
          : null;
      if (!prior) {
        throw validationError(
          "This request is still in approval - an approver can reject it; there is no decision to revoke"
        );
      }
      stageNo = Number(prior.revoked_stage_no);
      originalDecision = prior.original_decision;
    }

    const employeeId = Number(request.requested_for_employee_id);
    let locked = [];
    if (typeof attendanceCalculationUsecase.findPayrollLockedPeriods === "function") {
      locked = await attendanceCalculationUsecase.findPayrollLockedPeriods([
        { employee_id: employeeId, attendance_date: request.attendance_date },
      ]);
      if (locked.length > 0) throw payrollLockedActionError(locked, "This revocation");
    }

    if (reopen) {
      // THE SHIFT REQUEST WORKFLOW'S OWN GATES, as `raiseShiftChangeRequest`
      // applies them: the date window and the payroll lock
      // (`decidePreconditions`), another open or approved shift request for
      // the date, and the HR block. A request the workflow would refuse now
      // is not put back in front of an approver.
      const existing = await attendanceRegularizationRepo.findRequestsForDates(employeeId, [request.attendance_date]);
      const rival = (existing || []).find(
        (r) =>
          r.request_type === REQUEST_TYPE.SHIFT_CHANGE &&
          Number(r.attendance_approval_request_id) !== requestId &&
          (r.status === REQUEST_STATUS.PENDING || r.status === REQUEST_STATUS.APPROVED)
      );
      const blocked = shiftChangeEligibility.decidePreconditions({
        attendance_date: request.attendance_date,
        today: istToday(),
        payroll_locked: locked,
        existing_request: rival || null,
      });
      if (blocked) throw validationError(`This rejection cannot be reopened: ${blocked.reason}`);
      const activeBlock = await activeBlockFor(employeeId, request.attendance_date);
      if (shiftChangeBlock.isActive(activeBlock)) {
        throw validationError(
          `This rejection cannot be reopened: ${shiftChangeBlock.blockMessage({
            attendance_date: request.attendance_date,
            reason: activeBlock.reason,
          })}`
        );
      }
    }

    // THE DAY AS THE REVOCATION LEAVES IT. Cancelled: the day WITHOUT this
    // request - no approval state from it, no punch of it, and for an
    // approved SHIFT_CHANGE no override of it, so the date is dated and
    // calculated on the shift that applies without it and its authorised OT
    // is gone. Reopened: the day with the request PENDING again, which for a
    // shift request changes only the request state beside the day.
    const [voidedDay] = await attendanceCalculationUsecase.calculateRange(
      reopen
        ? {
            employee_id: employeeId,
            from_date: request.attendance_date,
            to_date: request.attendance_date,
            assume: {
              attendance_approval_request_id: requestId,
              attendance_date: request.attendance_date,
              request_type: request.request_type,
              status: REQUEST_STATUS.PENDING,
              candidate_ot_minutes: request.candidate_ot_minutes,
              reason: request.reason,
              approved_ot_minutes: 0,
            },
          }
        : {
            employee_id: employeeId,
            from_date: request.attendance_date,
            to_date: request.attendance_date,
            exclude_request_id: requestId,
          }
    );
    const dayState = dayStateOf(
      voidedDay || { attendance_date: request.attendance_date, shift_snapshot: null },
      { now }
    );
    const calculations =
      dayState.closed && voidedDay ? [attendanceCalculationUsecase.toStorageRow(voidedDay)] : [];

    const result = await attendanceRegularizationRepo.revokeRequest({
      requestId,
      stageNo,
      originalDecision,
      expectedFingerprint: snapshot.fingerprint,
      employeeId,
      actor: {
        employee_id: actor.employee_id === null || actor.employee_id === undefined ? null : Number(actor.employee_id),
        user_id: actor.user_id === null || actor.user_id === undefined ? null : Number(actor.user_id),
      },
      reason: why,
      revocableTypes: REVOCABLE_TYPES,
      calculations,
      attendanceDate: request.attendance_date,
    });
    // Revoking a Permission request changes what its day forgives (its own
    // path, unchanged); revoking any other type that rewrote the day - OT,
    // regularization, shift change - refreshes the month the same way.
    const committed = result && result.code === 200;
    const isPermission = request.request_type === REQUEST_TYPE.PERMISSION;
    const monthRefresh = !committed
      ? null
      : Array.isArray(month_refresh_collector) && (isPermission || calculations.length > 0)
      ? await refreshMonthsAfter([{ employee_id: employeeId, attendance_date: request.attendance_date }], {
          collector: month_refresh_collector,
        })
      : isPermission
      ? await refreshMonthAfter(employeeId, request.attendance_date, now)
      : calculations.length > 0
      ? await refreshMonthsAfter([{ employee_id: employeeId, attendance_date: request.attendance_date }], {
          now,
          source: `a ${request.request_type} revocation`,
        })
      : null;
    // The day without the revoked decision may carry eligible OT with no
    // final decision on it any more (a revoked OT approval, a revoked
    // correction): it goes back into approval, exactly as the engine says.
    const otAutoPending =
      committed && calculations.length > 0
        ? await syncAutoOtSafely({
            employee_id: employeeId,
            days: voidedDay ? [voidedDay] : [],
            now,
            source: `REVOKE_${request.request_type}`,
          })
        : null;
    return {
      ...result,
      month_refresh: monthRefresh,
      ot_auto_pending: otAutoPending,
      request_type: request.request_type,
      attendance_date: request.attendance_date,
      employee_id: employeeId,
      attendance_persisted: calculations.length > 0,
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
  const decide = async ({
    actor,
    request_id,
    decision,
    remarks = null,
    source = "WEB",
    now = null,
    month_refresh_collector = null,
    // OT only, optional: the minutes the approver was SHOWN. A Telegram
    // button carries them, so a message sent before a recalculation moved the
    // figure cannot approve a number the approver never saw.
    expected_ot_minutes = null,
  }) => {
    if (decision !== STEP_DECISION.APPROVED && decision !== STEP_DECISION.REJECTED) {
      throw validationError("decision must be APPROVED or REJECTED");
    }

    // A REJECTION MUST SAY WHY, on every request type and from either
    // surface. An approval speaks for itself; a refusal the employee cannot
    // read is a refusal they will simply file again.
    if (decision === STEP_DECISION.REJECTED && String(remarks || "").trim().length < 5) {
      throw validationError("A rejection reason of at least 5 characters is required");
    }

    const request = await attendanceRegularizationRepo.getRequest(request_id);
    if (!request) throw validationError(`No such request: ${request_id}`);

    /*
     * ALREADY PROCESSED - from DnDS, Telegram, the payroll lock or the system
     * withdrawing its own OT. Answered before anything else so an old button
     * or a second tab gets the plain answer; `decideStage`'s guarded UPDATEs
     * remain what makes a race between two live decisions safe.
     */
    if (request.status && request.status !== REQUEST_STATUS.PENDING) {
      return {
        code: 409,
        already_decided: true,
        status: request.status,
        attendance_approval_request_id: Number(request_id),
        attendance_date: request.attendance_date,
        approved_ot_minutes:
          request.approved_ot_minutes === null || request.approved_ot_minutes === undefined
            ? null
            : Number(request.approved_ot_minutes),
        msg:
          request.status === REQUEST_STATUS.CANCELLED
            ? "This request was withdrawn and can no longer be decided"
            : `This request has already been ${String(request.status).toLowerCase()}`,
      };
    }
    if (
      request.request_type === REQUEST_TYPE.OT &&
      expected_ot_minutes !== null &&
      expected_ot_minutes !== undefined &&
      Number(expected_ot_minutes) !== Math.max(0, Math.trunc(Number(request.candidate_ot_minutes) || 0))
    ) {
      return {
        code: 409,
        ot_minutes_changed: true,
        status: request.status,
        attendance_approval_request_id: Number(request_id),
        attendance_date: request.attendance_date,
        candidate_ot_minutes: Math.max(0, Math.trunc(Number(request.candidate_ot_minutes) || 0)),
        msg: `The eligible OT for ${request.attendance_date} is now ${Math.max(
          0,
          Math.trunc(Number(request.candidate_ot_minutes) || 0)
        )} min after an attendance recalculation - review it again`,
      };
    }

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
    const isShiftRequest = request.request_type === REQUEST_TYPE.SHIFT_CHANGE;
    // A PERMISSION is normally approved BEFORE the date is worked (a festival
    // release, a known appointment), exactly like a shift change: its final
    // approval on an open day commits the decision, and the date is stored
    // with the permission applied once it closes.
    const isPermissionRequest = request.request_type === REQUEST_TYPE.PERMISSION;
    const carriesOt = isOtRequest || request.request_type === REQUEST_TYPE.REGULARIZATION_WITH_OT;

    /*
     * THE PAYROLL LOCK, CHECKED AT THE DECISION AS WELL AS AT THE SUBMISSION.
     *
     * A request can sit in the queue while the month it belongs to is
     * approved and locked underneath it, so the check at submit time is not
     * the same check as this one and neither is redundant. An approval that
     * would recalculate a settled day is refused here in a sentence; the
     * transactional guard on the write refuses it again, and that is the one
     * a race cannot get past.
     *
     * A REJECTION IS ALLOWED. Rejecting changes no attendance and pays
     * nothing - it closes a request that would otherwise sit open for ever
     * against a month nobody can reopen.
     */
    if (decision === STEP_DECISION.APPROVED && typeof attendanceCalculationUsecase.findPayrollLockedPeriods === "function") {
      const locked = await attendanceCalculationUsecase.findPayrollLockedPeriods([
        { employee_id: request.requested_for_employee_id, attendance_date: request.attendance_date },
      ]);
      if (locked.length > 0) throw payrollLockedActionError(locked, "This approval");
    }

    /*
     * A PERMISSION ON A PRESENT/ABSENT ONLY DATE IS NOT APPROVED. A request
     * raised before the date became Present/Absent Only (the mode is
     * effective-dated and can be set after the request) may still be pending;
     * approving it would record a permission the date cannot use. REJECTING
     * it stays allowed, exactly as for a locked month, so it can be closed
     * with no new state. Its window is kept for audit either way, and the
     * engine applies any permission on such a date as zero.
     */
    if (
      decision === STEP_DECISION.APPROVED &&
      isPermissionRequest &&
      isPresentAbsentOnly(await attendanceModeFor(request.requested_for_employee_id, request.attendance_date))
    ) {
      throw permissionNotApplicableError();
    }

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
        /*
         * Clamped to what is CLAIMABLE now, which on a shift-authorised date
         * is the excess and not the whole candidate. This is the second half
         * of the no-double-pay rule: the engine adds the authorised portion
         * itself, so an OT approval that could reach it would pay those
         * minutes twice.
         */
        const eligible = currentDay
          ? Math.max(
              0,
              Math.trunc(
                Number(
                  currentDay.excess_ot_minutes === undefined || currentDay.excess_ot_minutes === null
                    ? currentDay.candidate_ot_minutes
                    : currentDay.excess_ot_minutes
                ) || 0
              )
            )
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
      // A SHIFT_CHANGE that is being finally approved is calculated under the
      // shift it asked for - the very shift the override below is about to
      // make effective - so the day committed with the decision is the day
      // the decision produces. At any other stage, and on a rejection, the
      // date is calculated exactly as it stands.
      assume_override:
        isShiftRequest && next.status === REQUEST_STATUS.APPROVED
          ? {
              attendance_date: request.attendance_date,
              work_shift_id: Number(request.requested_work_shift_id),
              // THE APPROVAL IS THE AUTHORISATION. The override row and this
              // decision commit together, so the day computed here must be
              // the day the override will produce - including the OT the
              // approved shift authorises. If the work has already happened
              // that figure appears immediately; if it has not, it is 0 now
              // and derived from the punches whenever they arrive, because
              // the stored override carries the same link.
              shift_change_approved: true,
              attendance_approval_request_id: Number(request_id),
            }
          : undefined,
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

    /*
     * THE DECISION AND THE DAY ROW ARE TWO THINGS, and only a CLOSED day gets
     * the second. Decided against the day as this decision produces it - for
     * an approved SHIFT_CHANGE that is the requested shift's snapshot and
     * cutoff, which is the one the date will be calculated under.
     *
     *   closed      decision + day row, one commit, exactly as before.
     *   open        a SHIFT_CHANGE may be finally approved: the approval and
     *               its override commit, the date reads LIVE_PREVIEW under the
     *               approved shift, and it is stored by the first ordinary
     *               recalculation after it closes. Any type's intermediate
     *               stage, and any rejection, is recorded the same way - a
     *               decision with no day row.
     *               A REGULARIZATION or OT final approval is REFUSED: it is
     *               the final settlement of a day that is not finished, and it
     *               can be given once the day closes.
     */
    const dayState = dayStateOf(
      correctedDay || { attendance_date: request.attendance_date, shift_snapshot: null },
      { now }
    );
    if (!dayState.closed && next.status === REQUEST_STATUS.APPROVED && !isShiftRequest && !isPermissionRequest) {
      throw dayOpenError(
        `${request.attendance_date}'s attendance day is still open${closesPhrase(dayState)}. ` +
          (carriesOt ? "Overtime" : "A regularization") +
          " can be finally approved once the day has closed; the request stays pending until then."
      );
    }
    const calculations =
      dayState.closed && correctedDay ? [attendanceCalculationUsecase.toStorageRow(correctedDay)] : [];

    const saved = await attendanceRegularizationRepo.decideStage({
      requestId: Number(request_id),
      stageNo: Number(step.stage_no),
      decision,
      actorId: identity.employee_id,
      remarks,
      adminOverride: verdict.as_admin_override,
      next: { ...next, approved_ot_minutes: approvedOt },
      calculations,
      // The payroll lock, taken on the date whether or not a day row goes
      // with the decision.
      attendanceLock: {
        employee_id: request.requested_for_employee_id,
        attendance_date: request.attendance_date,
      },
      // A Permission may be REJECTED in a locked month (it pays nothing);
      // every other type keeps the existing refusal.
      allowRejectWhenLocked: isPermissionRequest,
      decisionSource: source === "TELEGRAM" ? "TELEGRAM" : "WEB",
      // THE APPROVED SHIFT BECOMES EFFECTIVE HERE AND NOWHERE ELSE, in the
      // same transaction as the decision and the recalculated day. It is an
      // ordinary `attendance_date_shift_override` row - the same table, the
      // same resolver and the same one-date precedence a management edit
      // uses - carrying the request that authorized it.
      shiftOverride:
        isShiftRequest && next.status === REQUEST_STATUS.APPROVED
          ? {
              employee_id: request.requested_for_employee_id,
              attendance_date: request.attendance_date,
              work_shift_id: Number(request.requested_work_shift_id),
              previous_work_shift_id:
                request.base_work_shift_id === null || request.base_work_shift_id === undefined
                  ? null
                  : Number(request.base_work_shift_id),
              reason: request.reason,
            }
          : null,
    });
    if (saved.code !== 200) return saved;

    // A PERMISSION finally approved moves the day it covers; the monthly
    // summary payroll reads is re-persisted through the existing month path
    // (a no-op when the month has no summary yet). See `refreshPersistedMonth`.
    //
    // EVERY OTHER DECISION THAT WROTE A DAY - an OT, regularization or shift
    // change approval, a rejection that settled the day - refreshes it too,
    // through the same month persist. The Permission path is kept exactly.
    // An intermediate stage leaves the stored day as it was (the request is
    // still pending), so only the FINAL outcome refreshes.
    const permissionRefresh = isPermissionRequest && saved.status === REQUEST_STATUS.APPROVED;
    const otherRefresh =
      !isPermissionRequest && calculations.length > 0 && saved.status !== REQUEST_STATUS.PENDING;
    const entry = [{ employee_id: request.requested_for_employee_id, attendance_date: request.attendance_date }];
    const monthRefresh =
      Array.isArray(month_refresh_collector) && (permissionRefresh || otherRefresh)
        ? await refreshMonthsAfter(entry, { collector: month_refresh_collector })
        : permissionRefresh
        ? await refreshMonthAfter(request.requested_for_employee_id, request.attendance_date, now)
        : otherRefresh
        ? await refreshMonthsAfter(entry, { now, source: `a ${request.request_type} decision` })
        : null;

    // A FINAL decision that rewrote the day (a corrected punch, an approved
    // one-day shift, a permission) can move the day's eligible OT: the date's
    // pending OT follows it, or is raised now. After the commit, never inside
    // it - it pays nothing, and a failure is reported, not thrown.
    const otAutoPending =
      !isOtRequest && calculations.length > 0 && saved.status !== REQUEST_STATUS.PENDING
        ? await syncAutoOtSafely({
            employee_id: request.requested_for_employee_id,
            days: correctedDay ? [correctedDay] : [],
            now,
            source: `DECISION_${request.request_type}`,
          })
        : null;

    return {
      code: 200,
      month_refresh: monthRefresh,
      ot_auto_pending: otAutoPending,
      attendance_approval_request_id: Number(request_id),
      stage_no: Number(step.stage_no),
      decision,
      acted_as_admin_override: verdict.as_admin_override,
      status: saved.status,
      current_stage_no: saved.current_stage_no,
      finalization_state: saved.finalization_state,
      approved_ot_minutes: approvedOt,
      attendance_date: request.attendance_date,
      decision_source: source === "TELEGRAM" ? "TELEGRAM" : "WEB",
      attendance_date_shift_override_id:
        saved.attendance_date_shift_override_id === undefined
          ? null
          : saved.attendance_date_shift_override_id,
      recalculated: correctedDay || null,
      // Was that day STORED with the decision? False while the attendance day
      // is still open - it then reads live from the committed decision, and
      // `attendance_deferred` says until when.
      attendance_persisted: calculations.length > 0,
      attendance_deferred: dayState.closed
        ? null
        : { reason: dayState.reason, closes_at: dayState.closes_at },
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

    /*
     * WHAT IS UNRESOLVED IS THE CLAIMABLE PORTION, NOT THE CLAIM STATE.
     *
     * This used to select `ot_claim_state === "AVAILABLE"`, which was the
     * same thing while every day's overtime was either wholly claimable or
     * wholly claimed. It stopped being the same thing when an approved shift
     * change began authorising part of a day: such a date reads
     * APPROVED_VIA_SHIFT_CHANGE, so the old filter skipped it entirely - and
     * any EXCESS earned outside the approved shift, which nobody had
     * requested, survived the lock unresolved. The employee's screen went on
     * offering to claim it and the backend refused the click, which is the
     * one outcome the payroll-lock rule exists to prevent.
     *
     * So the question asked of each day is now the right one: how many
     * minutes are still CLAIMABLE and unclaimed?
     *
     *   claimable = excess_ot_minutes        (the whole candidate on an
     *                                         ordinary date, so nothing
     *                                         changes for one)
     *   unclaimed = no OT request exists on the date
     *
     * THE AUTHORISED PORTION IS NOT TOUCHED. It is already approved, by a
     * decision taken under Shift, and a closed period does not un-approve
     * what was approved before it closed - exactly as it does not touch a
     * settled OT approval. Only the claimable remainder is closed, and the
     * closure record carries THAT figure, so the day afterwards reads
     * "approved via shift change: 5h" and "excess: 30m, closed" - two facts,
     * neither hiding the other.
     */
    const claimableOf = (day) =>
      day.excess_ot_minutes === undefined || day.excess_ot_minutes === null
        ? Math.max(0, Math.trunc(Number(day.candidate_ot_minutes) || 0))
        : Math.max(0, Math.trunc(Number(day.excess_ot_minutes) || 0));

    // A date that already carries an OT request of any kind is the pending /
    // approved / rejected path's business, not this one's.
    const hasOtRequest = (day) =>
      (day.ot_request_id !== null && day.ot_request_id !== undefined) ||
      day.ot_claim_state === "REQUEST_PENDING" ||
      day.ot_claim_state === "APPROVED" ||
      day.ot_claim_state === "REJECTED" ||
      day.ot_claim_state === "CLOSED_AT_PAYROLL_LOCK";

    const unrequested = (days || [])
      .filter(
        (day) =>
          day &&
          day.attendance_date >= from &&
          day.attendance_date <= to &&
          !hasOtRequest(day) &&
          claimableOf(day) > 0
      )
      .map((day) => ({
        attendance_date: day.attendance_date,
        // THE EXCESS, never the whole candidate: closing the candidate on a
        // shift-authorised date would write a record claiming to close
        // minutes that are already approved.
        candidate_ot_minutes: claimableOf(day),
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
      /*
       * WHAT SURVIVED THE LOCK, counted truthfully.
       *
       * `approved_preserved` counted days whose OT REQUEST was approved,
       * which was every approved day until an approved shift change could
       * also carry approved OT without a request. A count that quietly
       * excluded those would have understated exactly the minutes this
       * release added. It now counts every day leaving the lock with
       * approved OT on it, and the two sources are broken out beside it so
       * the number can still be read either way.
       */
      approved_preserved: (days || []).filter(
        (d) => d && (d.ot_claim_state === "APPROVED" || d.ot_claim_state === "APPROVED_VIA_SHIFT_CHANGE")
      ).length,
      approved_via_ot_request: (days || []).filter((d) => d && d.ot_claim_state === "APPROVED").length,
      approved_via_shift_change: (days || []).filter(
        (d) => d && d.ot_claim_state === "APPROVED_VIA_SHIFT_CHANGE"
      ).length,
      // The minutes, not just the days: what payroll still owes after the
      // lock, and the figure a closure can never reduce.
      approved_minutes_preserved: (days || []).reduce(
        (total, d) => total + Math.max(0, Math.trunc(Number(d && d.approved_ot_minutes) || 0)),
        0
      ),
      unrequested_dates: unrequested.map((u) => u.attendance_date),
    };
  };

  /* ================================================ AUTOMATIC PENDING OT ===
   *
   *   Employee punches -> attendance engine calculates eligible OT
   *     -> PENDING OT approval (this) -> approver approves / rejects (decide,
   *        from DnDS or Telegram) -> only APPROVED OT is paid
   *
   * THE ENGINE IS THE SOURCE OF TRUTH. Whether a date has OT, and how many
   * minutes, is exactly what `raiseOtRequest` used to accept from an employee
   * request - the claimable minutes of a closed, complete, FINAL day
   * (`excess_ot_minutes`, which is the whole candidate on an ordinary date and
   * only the part outside an approved one-day shift on a shift-changed one).
   * No OT rule is restated here; the day is whatever `calculateRange` says.
   *
   * ONE RECORD PER DATE, the existing one. A date's OT is one ordinary
   * `attendance_approval_request` row (request_type OT, auto_created 1),
   * walking the employee's normal approval chain. What the sync does to it:
   *
   *   no OT record, eligible OT > 0         -> CREATE it PENDING
   *   PENDING, eligible minutes changed     -> follow them (an increase is
   *                                           held once a stage approved)
   *   PENDING auto record, OT now gone      -> WITHDRAW it (CANCELLED,
   *                                           steps SKIPPED) - never one an
   *                                           employee raised or an approver
   *                                           has started deciding
   *   APPROVED / REJECTED / payroll-closed  -> NEVER touched. An approval is
   *                                           already clamped by the engine
   *                                           to the day's eligible OT on
   *                                           every recalculation, and payroll
   *                                           flags APPROVED_OT_CHANGED - the
   *                                           existing correction path.
   *
   * IDEMPOTENT. Every date is matched against the OT record it already has,
   * and the database's open-request key refuses a second PENDING one, so a
   * retried or concurrent run creates nothing twice.
   *
   * GATED. Nothing is raised before the cutover date (migration
   * 20261124120000, the deploy date less five days), older than the request
   * backdate window, on a date whose day is still open, or in a payroll-locked
   * month - and a locked month's pending OT is not changed either.
   */
  const AUTO_OT_SKIP = Object.freeze({
    NO_DAY: "NO_DAY",
    NO_SHIFT: "NO_SHIFT",
    PRESENT_ABSENT_ONLY: "PRESENT_ABSENT_ONLY",
    DAY_OPEN: "DAY_OPEN",
    INCOMPLETE_DAY: "INCOMPLETE_DAY",
    BEFORE_CUTOVER: "BEFORE_CUTOVER",
    OUTSIDE_WINDOW: "OUTSIDE_WINDOW",
    NOT_EMPLOYED: "NOT_EMPLOYED",
    PAYROLL_LOCKED: "PAYROLL_LOCKED",
    NO_OT: "NO_OT",
  });

  let otNotifier = null;
  /** Telegram, set by `server.js`: messages the first approver of a new auto OT. */
  const setOtNotifier = (notifier) => {
    otNotifier = notifier || null;
  };

  /** What an approval may pay on this day: the claimable portion, never the shift-authorised one. */
  const claimableOtOf = (day) =>
    Math.max(
      0,
      Math.trunc(
        Number(
          day.excess_ot_minutes === undefined || day.excess_ot_minutes === null
            ? day.candidate_ot_minutes
            : day.excess_ot_minutes
        ) || 0
      )
    );

  /**
   * Whether the engine's day carries OT that belongs in approval now, with the
   * reason when it does not. The rules `raiseOtRequest` applied to an
   * employee's request, applied to the system's instead.
   */
  const autoOtVerdict = (day, { now, today }) => {
    if (!day) return { eligible: false, minutes: 0, reason: AUTO_OT_SKIP.NO_DAY };
    if (isPresentAbsentOnly(day.attendance_calculation_mode)) {
      return { eligible: false, minutes: 0, reason: AUTO_OT_SKIP.PRESENT_ABSENT_ONLY };
    }
    if (!day.shift_snapshot) return { eligible: false, minutes: 0, reason: AUTO_OT_SKIP.NO_SHIFT };
    const state = dayStateOf(day, { now, today });
    if (!state.closed) return { eligible: false, minutes: 0, reason: AUTO_OT_SKIP.DAY_OPEN };
    if (day.is_final !== true || day.status !== CALC_STATUS.FINAL || Number(day.punch_count) % 2 === 1) {
      return { eligible: false, minutes: 0, reason: AUTO_OT_SKIP.INCOMPLETE_DAY };
    }
    const minutes = claimableOtOf(day);
    if (minutes <= 0) return { eligible: false, minutes: 0, reason: AUTO_OT_SKIP.NO_OT };
    return { eligible: true, minutes, reason: null };
  };

  /** "09:00" from "09:00:00"; "11:42" from "2026-10-06 11:42:10". */
  const clockOf = (value) => {
    if (!value) return null;
    const s = String(value);
    const m = /(\d{2}:\d{2})(:\d{2})?$/.exec(s);
    return m ? m[1] : s;
  };

  /** Everything an approver needs to decide, from the day the engine calculated. */
  const otContextFor = (day, identity, request) => {
    const punches = Array.isArray(day && day.effective_punches) ? day.effective_punches : [];
    const snapshot = (day && day.shift_snapshot) || {};
    return {
      attendance_approval_request_id: request.attendance_approval_request_id,
      employee_id: identity.employee_id,
      employee_name: identity.employee_name || null,
      outlet_name: identity.outlet_name || null,
      attendance_date: day.attendance_date,
      shift_code: snapshot.shift_code || null,
      shift_in_time: clockOf(snapshot.in_time),
      shift_out_time: clockOf(snapshot.out_time),
      punch_in: punches.length > 0 ? clockOf(punches[0].io_time) : null,
      punch_out: punches.length > 1 ? clockOf(punches[punches.length - 1].io_time) : null,
      worked_minutes: day.worked_minutes === undefined ? null : day.worked_minutes,
      eligible_ot_minutes: request.candidate_ot_minutes,
      chain: request.chain || [],
    };
  };

  const notifyOtApprover = async (context) => {
    if (!otNotifier || typeof otNotifier.notifyFirstApprover !== "function") {
      return { sent: false, reason: "NOT_WIRED" };
    }
    try {
      return await otNotifier.notifyFirstApprover(context);
    } catch (err) {
      return { sent: false, reason: "SEND_FAILED", message: err && err.message ? err.message : String(err) };
    }
  };

  /**
   * Bring one employee's OT approval records in line with the engine for some
   * dates.
   *
   * @param {object}   input
   * @param {number}   input.employee_id
   * @param {object[]} [input.days]   days `calculateRange` already returned
   *                                  (a recalculation passes the days it just
   *                                  stored, so nothing is calculated twice)
   * @param {string[]} [input.dates]  otherwise these dates are calculated now
   * @param {string}   [input.source] what triggered it, for the audit row
   * @param {boolean}  [input.dry_run] report what WOULD happen, write nothing
   * @param {boolean}  [input.notify]  message the first approver on Telegram
   */
  const syncAutoOt = async ({
    employee_id,
    days = null,
    dates = null,
    now = null,
    today = null,
    source = "RECALCULATION",
    dry_run = false,
    notify = true,
    // DRY RUN ONLY: the cutover to assume, so a preview can be taken before
    // the migration has seeded the real row. Ignored when writing.
    assume_setting = null,
  }) => {
    const employeeId = Number(employee_id);
    const result = {
      employee_id: employeeId,
      enabled: false,
      dry_run: !!dry_run,
      created: [],
      updated: [],
      withdrawn: [],
      unchanged: [],
      preserved_approved: [],
      preserved_rejected: [],
      held: [],
      skipped: [],
      errors: [],
    };
    if (!Number.isInteger(employeeId) || employeeId <= 0) return result;

    const setting =
      dry_run && assume_setting
        ? assume_setting
        : typeof attendanceRegularizationRepo.getAutoOtSetting === "function"
        ? await attendanceRegularizationRepo.getAutoOtSetting()
        : null;
    if (!setting || !tinyBool(setting.enabled) || !setting.auto_pending_from_date) return result;
    result.enabled = true;
    const cutover = toDateOnly(setting.auto_pending_from_date);

    // The business date: the one pinned, else the date of the run's own
    // instant (a bulk run judges every employee at one moment), else now.
    const instant = typeof now === "number" ? now : now instanceof Date ? now.getTime() : null;
    const businessToday = today ? istToday(today) : instant !== null ? istDateOf(instant) : istToday();
    const oldest = addDays(businessToday, -MAX_BACKDATE_DAYS);

    // THE DAYS. Either handed over, or calculated now from the database.
    let calculated = Array.isArray(days) ? days.filter((d) => d && d.attendance_date) : null;
    if (!calculated) {
      const wanted = [...new Set((dates || []).map(toDateOnly).filter(Boolean))].sort();
      if (wanted.length === 0) return result;
      const range = await attendanceCalculationUsecase.calculateRange({
        employee_id: employeeId,
        from_date: wanted[0],
        to_date: wanted[wanted.length - 1],
      });
      calculated = (range || []).filter((d) => d && wanted.includes(d.attendance_date));
    }

    const skip = (date, reason) => result.skipped.push({ attendance_date: date, reason });
    const inScope = [];
    for (const day of calculated) {
      const date = day.attendance_date;
      if (date > businessToday) continue;
      if (cutover && date < cutover) {
        skip(date, AUTO_OT_SKIP.BEFORE_CUTOVER);
        continue;
      }
      if (date < oldest) {
        skip(date, AUTO_OT_SKIP.OUTSIDE_WINDOW);
        continue;
      }
      inScope.push(day);
    }
    if (inScope.length === 0) return result;

    // EMPLOYMENT: no OT before joining or after the last working date.
    let window = null;
    if (typeof attendanceCalculationUsecase.employmentWindowFor === "function") {
      window = await attendanceCalculationUsecase.employmentWindowFor(employeeId);
    }
    const employed = (date) =>
      !window || ((!window.joined_on || date >= window.joined_on) && (!window.ended_on || date <= window.ended_on));

    // THE PAYROLL LOCK, once for every date: nothing is raised or changed in
    // a locked month.
    // One lookup for every month the dates touch; a hit names a period.
    const lockedDates = new Set();
    if (typeof attendanceCalculationUsecase.findPayrollLockedPeriods === "function") {
      const locked = await attendanceCalculationUsecase.findPayrollLockedPeriods(
        inScope.map((day) => ({ employee_id: employeeId, attendance_date: day.attendance_date }))
      );
      const lockedMonths = new Set(
        (locked || []).map((p) => `${Number(p.year !== undefined ? p.year : p.period_year)}-${Number(p.month !== undefined ? p.month : p.period_month)}`)
      );
      inScope.forEach((day) => {
        const key = `${Number(day.attendance_date.slice(0, 4))}-${Number(day.attendance_date.slice(5, 7))}`;
        if (lockedMonths.has(key)) lockedDates.add(day.attendance_date);
      });
    }

    const existing = await attendanceRegularizationRepo.findOtRequestsForSync(
      employeeId,
      inScope.map((d) => d.attendance_date)
    );
    const byDate = new Map();
    (existing || []).forEach((row) => {
      const date = toDateOnly(row.attendance_date);
      if (!byDate.has(date)) byDate.set(date, row);
    });

    let identity = null;

    for (const day of inScope) {
      const date = day.attendance_date;
      try {
        /* eslint-disable no-await-in-loop */
        const verdict = employed(date)
          ? autoOtVerdict(day, { now, today })
          : { eligible: false, minutes: 0, reason: AUTO_OT_SKIP.NOT_EMPLOYED };
        const locked = lockedDates.has(date);
        const request = byDate.get(date) || null;
        const requestId = request ? Number(request.attendance_approval_request_id) : null;

        // A FINAL DECISION IS NEVER TOUCHED.
        if (request && request.status === REQUEST_STATUS.APPROVED) {
          result.preserved_approved.push({
            attendance_date: date,
            attendance_approval_request_id: requestId,
            approved_ot_minutes: Number(request.approved_ot_minutes) || 0,
            eligible_ot_minutes: verdict.minutes,
          });
          continue;
        }
        if (request && request.status === REQUEST_STATUS.REJECTED) {
          result.preserved_rejected.push({
            attendance_date: date,
            attendance_approval_request_id: requestId,
            closure_reason: request.closure_reason || null,
            eligible_ot_minutes: verdict.minutes,
          });
          continue;
        }

        if (request) {
          // PENDING. A locked month's pending OT is frozen with the month.
          if (locked) {
            skip(date, AUTO_OT_SKIP.PAYROLL_LOCKED);
            continue;
          }
          const current = Math.max(0, Math.trunc(Number(request.candidate_ot_minutes) || 0));
          const decidedSteps = Number(request.decided_steps) || 0;
          if (request.request_type !== REQUEST_TYPE.OT) {
            // A legacy REGULARIZATION_WITH_OT carries its own OT; left as is.
            result.unchanged.push({ attendance_date: date, attendance_approval_request_id: requestId, legacy: true });
            continue;
          }
          if (!verdict.eligible) {
            if (tinyBool(request.auto_created) && decidedSteps === 0) {
              if (!dry_run) {
                const done = await attendanceRegularizationRepo.withdrawAutoOtRequest({
                  requestId,
                  reason: `Withdrawn by the system: ${date} no longer has eligible overtime (${verdict.reason})`,
                  triggerSource: source,
                });
                if (!done || !done.withdrawn) {
                  result.unchanged.push({ attendance_date: date, attendance_approval_request_id: requestId, moved: true });
                  continue;
                }
              }
              result.withdrawn.push({
                attendance_date: date,
                attendance_approval_request_id: requestId,
                previous_ot_minutes: current,
                reason: verdict.reason,
              });
            } else {
              // Raised by an employee, or already part-approved: an approver
              // closes it (approval is clamped to 0 eligible minutes anyway).
              result.held.push({
                attendance_date: date,
                attendance_approval_request_id: requestId,
                ot_minutes: current,
                eligible_ot_minutes: 0,
                reason: verdict.reason,
              });
            }
            continue;
          }
          if (verdict.minutes === current) {
            result.unchanged.push({ attendance_date: date, attendance_approval_request_id: requestId, ot_minutes: current });
            continue;
          }
          if (verdict.minutes > current && decidedSteps > 0) {
            result.held.push({
              attendance_date: date,
              attendance_approval_request_id: requestId,
              ot_minutes: current,
              eligible_ot_minutes: verdict.minutes,
              reason: "INCREASE_AFTER_PARTIAL_APPROVAL",
            });
            continue;
          }
          if (!dry_run) {
            const done = await attendanceRegularizationRepo.setPendingOtMinutes({
              requestId,
              fromMinutes: current,
              toMinutes: verdict.minutes,
              triggerSource: source,
            });
            if (!done || !done.updated) {
              result.unchanged.push({
                attendance_date: date,
                attendance_approval_request_id: requestId,
                moved: true,
                reason: done ? done.reason : null,
              });
              continue;
            }
          }
          result.updated.push({
            attendance_date: date,
            attendance_approval_request_id: requestId,
            previous_ot_minutes: current,
            ot_minutes: verdict.minutes,
          });
          continue;
        }

        // NO OT RECORD ON THE DATE.
        if (!verdict.eligible) {
          if (verdict.reason !== AUTO_OT_SKIP.NO_OT && verdict.reason !== AUTO_OT_SKIP.NO_DAY) skip(date, verdict.reason);
          continue;
        }
        if (locked) {
          skip(date, AUTO_OT_SKIP.PAYROLL_LOCKED);
          continue;
        }
        if (dry_run) {
          result.created.push({ attendance_date: date, attendance_approval_request_id: null, ot_minutes: verdict.minutes });
          continue;
        }
        if (!identity) identity = await resolveIdentity(employeeId);
        const who = identity;
        const { chain, source: chain_source } = await resolveChain(who);
        let created;
        try {
          created = await attendanceRegularizationRepo.createRequest({
            request: {
              request_type: REQUEST_TYPE.OT,
              requested_for_employee_id: employeeId,
              // The employee is the nominal requester of their own OT: the
              // chain is theirs, and no approver is ever shown their own.
              requested_by_employee_id: employeeId,
              attendance_date: date,
              outlet_id: who.outlet_id,
              requester_class: who.requester_class,
              reason: `System: ${verdict.minutes} min eligible overtime calculated by the attendance engine`,
              candidate_ot_minutes: verdict.minutes,
              auto_created: true,
              chain_source,
              refuse_when_payroll_locked: true,
            },
            chain,
            punch: null,
          });
        } catch (err) {
          // THE RACE, LOST: a concurrent run raised it first. Idempotent.
          if (err && err.code === "ER_DUP_ENTRY") {
            result.unchanged.push({ attendance_date: date, duplicate_prevented: true });
            continue;
          }
          if (err && err.code === "PAYROLL_MONTH_LOCKED") {
            skip(date, AUTO_OT_SKIP.PAYROLL_LOCKED);
            continue;
          }
          throw err;
        }
        const newId = Number(created.attendance_approval_request_id);
        if (typeof attendanceRegularizationRepo.logAutoOt === "function") {
          await attendanceRegularizationRepo.logAutoOt({
            attendance_approval_request_id: newId,
            employee_id: employeeId,
            attendance_date: date,
            action: "CREATED",
            previous_ot_minutes: null,
            new_ot_minutes: verdict.minutes,
            trigger_source: source,
          });
        }
        const entry = {
          attendance_date: date,
          attendance_approval_request_id: newId,
          ot_minutes: verdict.minutes,
        };
        if (notify) {
          entry.telegram = await notifyOtApprover(
            otContextFor(day, who, { attendance_approval_request_id: newId, candidate_ot_minutes: verdict.minutes, chain })
          );
        }
        result.created.push(entry);
        /* eslint-enable no-await-in-loop */
      } catch (err) {
        result.errors.push({ attendance_date: date, message: err && err.message ? err.message : String(err) });
      }
    }
    return result;
  };

  /**
   * What an approver is shown for one OT request, from the live day: the
   * Telegram card, and the fresh card sent when an old one's figure moved.
   */
  const otApprovalContext = async (requestId) => {
    const request = await attendanceRegularizationRepo.getRequest(requestId);
    if (!request || request.request_type !== REQUEST_TYPE.OT) return null;
    const employeeId = Number(request.requested_for_employee_id);
    const [day] = await attendanceCalculationUsecase.calculateRange({
      employee_id: employeeId,
      from_date: request.attendance_date,
      to_date: request.attendance_date,
    });
    const who = await resolveIdentity(employeeId);
    return otContextFor(day || { attendance_date: request.attendance_date }, who, {
      attendance_approval_request_id: Number(request.attendance_approval_request_id),
      candidate_ot_minutes: Math.max(0, Math.trunc(Number(request.candidate_ot_minutes) || 0)),
      chain: request.steps || [],
    });
  };

  /**
   * The sync after a write that has ALREADY committed (a recalculation, a
   * decision). Raising an approval request makes nothing payable, so a
   * failure here must not be reported as a failure of what triggered it: it
   * is logged and returned on `error`, and the next recalculation of the
   * date (the 06:55 daily run covers the last three days) raises it.
   */
  const syncAutoOtSafely = async (input) => {
    try {
      return await syncAutoOt(input);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.ATTENDANCE_REGULARIZATION",
        code: "USECASE.ATTENDANCE_REGULARIZATION.AUTO-OT-SYNC",
        description: err && err.toString ? err.toString() : String(err),
        category: "",
        ref: { employee_id: input && input.employee_id, source: input && input.source },
      });
      return { employee_id: input && input.employee_id, enabled: null, error: err && err.message ? err.message : String(err) };
    }
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

  const APPROVAL_TYPES = [
    REQUEST_TYPE.REGULARIZATION,
    REQUEST_TYPE.OT,
    REQUEST_TYPE.SHIFT_CHANGE,
    REQUEST_TYPE.PERMISSION,
  ];

  /**
   * The request types ONE TAB of the approval centre shows.
   *
   * The Attendance tab shows the legacy REGULARIZATION_WITH_OT rows beside
   * the plain regularizations: new code never creates that type, but the rows
   * that exist are missing-punch corrections and belong where a reader would
   * look for them. Nothing else is grouped.
   */
  const typesForTab = (requestType) =>
    requestType === REQUEST_TYPE.REGULARIZATION
      ? [REQUEST_TYPE.REGULARIZATION, REQUEST_TYPE.REGULARIZATION_WITH_OT]
      : [requestType];
  const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ALL"];

  /**
   * The approval centre's filters, and the OUTLET SCOPE they sit inside.
   *
   * The scope comes from `actor.branch_scope`, which
   * `middlewares/employee_branch_scope.js` resolves from the server's own
   * facts - the actor's user_type, their all-branches key, and their live
   * branch assignment - and never from anything the client sent. It FAILS
   * CLOSED: an actor who arrives without a resolved scope is given the empty
   * list, which the repository renders as `1 = 0`. A route that forgets to
   * resolve the scope therefore shows nothing and is noticed, rather than
   * quietly showing every outlet in the company.
   *
   * The outlets a user CHOSE can only narrow that, never widen it: a chosen
   * outlet they have no rights to simply matches nothing.
   */
  const screenFilters = ({ actor, outlet_ids, employee_id, designation_id }) => {
    const scope = actor && actor.branch_scope ? actor.branch_scope : null;
    // The same three cases, in the same order and with the same closing
    // default, as `repository/employee_scope.js#accessScope`. Written out
    // rather than imported because that function renders SQL for a different
    // table; what is shared is the RULE, and the rule is stated identically.
    const permitted =
      scope && scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES
        ? null
        : scope &&
          scope.kind === EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES &&
          Array.isArray(scope.store_ids) &&
          scope.store_ids.length > 0
        ? scope.store_ids.map(Number)
        : [];

    const chosen = Array.isArray(outlet_ids)
      ? outlet_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    return {
      permitted_outlet_ids: permitted,
      filter_outlet_ids: chosen.length > 0 ? chosen : null,
      filter_employee_id: employee_id ? Number(employee_id) : null,
      filter_designation_id: designation_id ? Number(designation_id) : null,
    };
  };

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
  const listApprovals = async ({
    actor,
    request_type,
    status = "PENDING",
    limit = 200,
    offset = 0,
    outlet_ids = null,
    employee_id = null,
    designation_id = null,
  }) => {
    if (!APPROVAL_TYPES.includes(request_type)) {
      throw validationError("request_type must be REGULARIZATION, OT, SHIFT_CHANGE or PERMISSION");
    }
    if (!APPROVAL_STATUSES.includes(status)) {
      throw validationError("status must be PENDING, APPROVED, REJECTED or ALL");
    }
    const identity = await resolveIdentity(actor.employee_id);
    const isAdmin = Number(actor.user_type) === ADMIN_USER_TYPE;
    const roles = rolesFor(identity, actor);
    const scope = {
      request_type: typesForTab(request_type),
      status,
      approver_roles: roles,
      outlet_id: identity.outlet_id,
      actor_employee_id: identity.employee_id,
      is_admin: isAdmin,
      ...screenFilters({ actor, outlet_ids, employee_id, designation_id }),
    };

    const [rows, total] = await Promise.all([
      attendanceRegularizationRepo.listApprovals({ ...scope, limit, offset }),
      attendanceRegularizationRepo.countApprovals(scope),
    ]);
    const steps = await attendanceRegularizationRepo.listStepsForRequests(
      rows.map((r) => Number(r.attendance_approval_request_id))
    );
    // Who revoked what, and when - the audit, shown with the request.
    const revocations =
      typeof attendanceRegularizationRepo.listRevocationsForRequests === "function"
        ? await attendanceRegularizationRepo.listRevocationsForRequests(
            rows.map((r) => Number(r.attendance_approval_request_id))
          )
        : [];
    const revocationsByRequest = new Map();
    (revocations || []).forEach((v) => {
      const id = Number(v.attendance_approval_request_id);
      if (!revocationsByRequest.has(id)) revocationsByRequest.set(id, []);
      revocationsByRequest.get(id).push(v);
    });
    // PERMISSION: the windows each request asks for, in one read.
    const permissionsByRequest = new Map();
    if (request_type === REQUEST_TYPE.PERMISSION && typeof attendanceRegularizationRepo.listPermissionsForRequests === "function") {
      const permissionRows = await attendanceRegularizationRepo.listPermissionsForRequests(
        rows.map((r) => Number(r.attendance_approval_request_id))
      );
      (permissionRows || []).forEach((p) => {
        const id = Number(p.attendance_approval_request_id);
        if (!permissionsByRequest.has(id)) permissionsByRequest.set(id, []);
        permissionsByRequest.get(id).push(p);
      });
    }
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

      // PERMISSION, PENDING: what the day becomes IF this request is
      // approved - the same engine with the approval assumed, nothing
      // stored - so the approver sees the shortage it would forgive, not
      // only the window it asks for.
      let permissionPreview = null;
      if (row.request_type === REQUEST_TYPE.PERMISSION && row.status === REQUEST_STATUS.PENDING) {
        /* eslint-disable no-await-in-loop */
        const [assumed] = await attendanceCalculationUsecase.calculateRange({
          employee_id: Number(row.requested_for_employee_id),
          from_date: row.attendance_date,
          to_date: row.attendance_date,
          assume: {
            attendance_approval_request_id: id,
            attendance_date: row.attendance_date,
            request_type: REQUEST_TYPE.PERMISSION,
            status: REQUEST_STATUS.APPROVED,
          },
        });
        /* eslint-enable no-await-in-loop */
        // On a Present/Absent Only date there is nothing to preview: approval
        // is refused (see decide), so the approver is told why instead of
        // being shown "short 0 - permission covers 0 - short 0".
        permissionPreview = assumed && isPresentAbsentOnly(assumed.attendance_calculation_mode)
          ? {
              not_applicable: true,
              attendance_calculation_mode: assumed.attendance_calculation_mode,
              message: PERMISSION_NOT_APPLICABLE_MESSAGE,
            }
          : assumed
          ? {
              shortage_before_permission_minutes: assumed.shortage_before_permission_minutes,
              permission_minutes: assumed.permission_minutes,
              shortage_after_permission_minutes: assumed.shortage_minutes,
              calculation_source: assumed.calculation_source || null,
            }
          : null;
      }

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
      // The CLAIMABLE minutes - on a date with an approved one-day shift
      // that is the excess only, which is also what an approval is clamped to.
      const eligible = day
        ? claimableOtOf(day)
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
        closure_label:
          row.closure_reason && row.request_type === REQUEST_TYPE.PERMISSION
            ? PERMISSION_CLOSURE_LABEL
            : row.closure_reason && OT_CLOSURE[row.closure_reason]
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
        // SHIFT_CHANGE: the two shifts, as the Shift tab's table names them.
        // Null on every other type rather than absent, so one row shape
        // serves all three tabs.
        requested_work_shift_id:
          row.requested_work_shift_id === null || row.requested_work_shift_id === undefined
            ? null
            : Number(row.requested_work_shift_id),
        requested_shift_code: row.requested_shift_code || null,
        requested_shift_name: row.requested_shift_name || null,
        base_work_shift_id:
          row.base_work_shift_id === null || row.base_work_shift_id === undefined
            ? null
            : Number(row.base_work_shift_id),
        base_shift_code: row.base_shift_code || null,
        base_shift_name: row.base_shift_name || null,
        designation_id: row.designation_id === null || row.designation_id === undefined ? null : Number(row.designation_id),
        // PERMISSION: the windows asked for, and (pending only) what they
        // would forgive. Empty / null on every other type.
        permissions: (permissionsByRequest.get(id) || []).map(permissionForDisplay),
        permission_preview: permissionPreview,
        // "Approval Stage", as the Shift table's own column: which of how
        // many, and who it is with.
        approval_stage: `${Number(row.current_stage_no)} of ${Number(row.total_stages)}`,
        // The day, live for pending rows and stored for history.
        shift_name: row.shift_name || (day ? day.shift_name : null) || null,
        shift_code: snapshot ? snapshot.shift_code || null : null,
        shift_in_time: snapshot ? snapshot.in_time || null : null,
        shift_out_time: snapshot ? snapshot.out_time || null : null,
        effective_punches: Array.isArray(punches) ? punches : [],
        nrm_minutes: day ? day.nrm_minutes : row.nrm_minutes,
        // The PAYROLL BASE for the date. On the OT tab this is the "Regular
        // NRM" column, and on a date carrying an approved one-day shift it is
        // deliberately NOT the NRM above.
        base_nrm_minutes: day
          ? day.base_nrm_minutes
          : row.base_nrm_minutes === null || row.base_nrm_minutes === undefined
          ? row.nrm_minutes
          : row.base_nrm_minutes,
        regular_minutes: day
          ? day.regular_minutes
          : row.regular_minutes === null || row.regular_minutes === undefined
          ? null
          : row.regular_minutes,
        worked_minutes: day ? day.worked_minutes : row.worked_minutes,
        shortage_minutes: day ? day.shortage_minutes : row.shortage_minutes,
        // OT: what was claimed when raised, what the engine finds eligible,
        // and what was finally approved. Never editable by an approver - the
        // decision endpoint takes no minutes at all.
        // WHO RAISED THE OT: the attendance engine (SYSTEM) or, before
        // automatic pending OT, the employee (EMPLOYEE). Same record either way.
        auto_created: tinyBool(row.auto_created),
        ot_source: request_type === REQUEST_TYPE.OT ? (tinyBool(row.auto_created) ? "SYSTEM" : "EMPLOYEE") : null,
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
        // May the VIEWER revoke this request? The server's answer, so the
        // screen offers the control exactly where `revokeDecision` would
        // accept it - and the endpoint still decides for itself. A decided
        // request, or one the earlier reopening revoke put back in the queue.
        revocable:
          isAdmin &&
          REVOCABLE_TYPES.includes(row.request_type) &&
          !row.closure_reason &&
          (row.status === REQUEST_STATUS.APPROVED ||
            row.status === REQUEST_STATUS.REJECTED ||
            // A request the EARLIER reopening revoke left pending may still
            // be voided - never a reopened Shift rejection, which is simply
            // back in approval.
            (row.status === REQUEST_STATUS.PENDING &&
              row.request_type !== REQUEST_TYPE.SHIFT_CHANGE &&
              (revocationsByRequest.get(id) || []).length > 0)),
        revoked: row.status === REQUEST_STATUS.CANCELLED && (revocationsByRequest.get(id) || []).length > 0,
        revocations: (revocationsByRequest.get(id) || []).map((v) => ({
          attendance_approval_revocation_id: Number(v.attendance_approval_revocation_id),
          revoked_stage_no: Number(v.revoked_stage_no),
          revoked_approval_level: v.revoked_approval_level || null,
          original_decision: v.original_decision,
          original_decided_by_name: v.original_decided_by_name || null,
          original_decided_at: v.original_decided_at || null,
          original_request_status: v.original_request_status,
          original_approved_ot_minutes:
            v.original_approved_ot_minutes === null || v.original_approved_ot_minutes === undefined
              ? null
              : Number(v.original_approved_ot_minutes),
          revoked_by_employee_id:
            v.revoked_by_employee_id === null || v.revoked_by_employee_id === undefined
              ? null
              : Number(v.revoked_by_employee_id),
          revoked_by_name: v.revoked_by_name || null,
          revoked_at: v.revoked_at || null,
          reason: v.reason,
        })),
      });
    }

    return { rows: shaped, total, request_type, status, limit, offset, approver_roles: roles };
  };

  /**
   * BULK ACTIONS - Approve, Reject and Revoke many requests of ONE tab at once.
   *
   * NOT A SECOND WORKFLOW. Every selected request goes, one at a time, through
   * the very same `decide` or `revokeDecision` the single-record endpoints
   * call, so the authority check (`canApprove`), the payroll lock, the
   * open-day rule, the OT clamp, the shift override, the fingerprint and
   * `FOR UPDATE` checks, the transaction and the request's own history are
   * exactly those of a single action and cannot drift from them. What this
   * adds is only what a batch needs:
   *
   *   - the TAB. Every id is re-read from the database and must be of the
   *     tab's request type, so a SHIFT_CHANGE cannot ride in under the OT tab
   *     (and past the Shift key the route checked for the tab);
   *   - the state the approver SAW. A request that is no longer in the state
   *     it was selected in - decided by somebody else, moved to another
   *     stage, revoked - is reported as changed and left alone, instead of
   *     being decided at a stage the approver never looked at;
   *   - PARTIAL SUCCESS. One record's refusal never stops the others, and a
   *     record that succeeded stays done;
   *   - one log row PER RECORD under one operation id.
   *
   * NOTHING FROM THE CLIENT IS TRUSTED BEYOND THE IDS. The type, employee,
   * status, stage, minutes and decision history are all read from the stored
   * request by the single-record method.
   */
  const BULK_ACTION = Object.freeze({ APPROVE: "APPROVE", REJECT: "REJECT", REVOKE: "REVOKE" });
  const BULK_OUTCOME = Object.freeze({ SUCCEEDED: "SUCCEEDED", SKIPPED: "SKIPPED", FAILED: "FAILED" });
  // One HTTP call. The screen sends a larger selection in chunks of this or
  // fewer, so no single request runs long enough to meet a proxy timeout.
  const MAX_BULK_ITEMS = 100;
  // "Select all matching the filters": the most ids one call will return.
  const MAX_BULK_TARGETS = 1000;

  /**
   * Why a single-record action refused, as a bulk outcome. A business rule
   * that said no is SKIPPED - nothing was attempted against the data; a
   * record whose state moved underneath, or an unexpected error, is FAILED.
   */
  const bulkRefusal = (err) => {
    if (err && err.name === "ForbiddenError") {
      return { outcome: BULK_OUTCOME.SKIPPED, code: "NOT_PERMITTED", message: err.message };
    }
    if (err && err.code === "PAYROLL_MONTH_LOCKED") {
      return { outcome: BULK_OUTCOME.SKIPPED, code: "PAYROLL_LOCKED", message: err.message };
    }
    if (err && err.code === "ATTENDANCE_DAY_OPEN") {
      return { outcome: BULK_OUTCOME.SKIPPED, code: "DAY_OPEN", message: err.message };
    }
    if (err && err.name === "ValidationError") {
      return { outcome: BULK_OUTCOME.SKIPPED, code: "NOT_ELIGIBLE", message: err.message };
    }
    return {
      outcome: BULK_OUTCOME.FAILED,
      code: "ERROR",
      message: "The action could not be completed for this request; it was not changed.",
    };
  };

  const bulkReasonCheck = (action, reason) => {
    const why = typeof reason === "string" ? reason.trim() : "";
    if (action === BULK_ACTION.REJECT && why.length < 5) {
      throw validationError("A rejection reason of at least 5 characters is required");
    }
    if (action === BULK_ACTION.REVOKE && why.length < 5) {
      throw validationError("A revoke reason of at least 5 characters is required");
    }
    if (why.length > 500) throw validationError("A reason may be at most 500 characters");
    return why;
  };

  /**
   * The ids, in the order given, each with the state the screen showed.
   * `current_stage_no` (Approve / Reject) and `status` (Revoke) are what the
   * approver saw; either may be omitted, and then only the server's own
   * status rule applies.
   */
  const bulkItems = (items) => {
    if (!Array.isArray(items) || items.length === 0) throw validationError("Select at least one request");
    if (items.length > MAX_BULK_ITEMS) {
      throw validationError(`At most ${MAX_BULK_ITEMS} requests can be actioned in one call`);
    }
    const seen = new Set();
    const out = [];
    for (const raw of items) {
      const item = raw !== null && typeof raw === "object" ? raw : { request_id: raw };
      const id = Number(item.request_id);
      if (!Number.isInteger(id) || id <= 0) throw validationError("Every request_id must be a request id");
      if (seen.has(id)) continue;
      seen.add(id);
      const stage = item.current_stage_no === null || item.current_stage_no === undefined ? null : Number(item.current_stage_no);
      out.push({
        request_id: id,
        current_stage_no: Number.isInteger(stage) && stage > 0 ? stage : null,
        status: typeof item.status === "string" ? item.status : null,
      });
    }
    return out;
  };

  const bulkAction = async ({
    actor,
    revoke_actor = null,
    action,
    request_type,
    items,
    reason = null,
    now = null,
    bulk_operation_id = null,
  }) => {
    if (!Object.values(BULK_ACTION).includes(action)) {
      throw validationError("action must be APPROVE, REJECT or REVOKE");
    }
    if (!APPROVAL_TYPES.includes(request_type)) {
      throw validationError("request_type must be REGULARIZATION, OT, SHIFT_CHANGE or PERMISSION");
    }
    const why = bulkReasonCheck(action, reason);
    const targets = bulkItems(items);
    if (action === BULK_ACTION.REVOKE && (!revoke_actor || Number(revoke_actor.user_type) !== ADMIN_USER_TYPE)) {
      const err = new Error("Only an administrator can revoke an approval decision");
      err.name = "ForbiddenError";
      throw err;
    }
    const operationId = bulk_operation_id || crypto.randomUUID();
    const tabTypes = typesForTab(request_type);
    const logActor =
      action === BULK_ACTION.REVOKE
        ? { employee_id: revoke_actor.employee_id, user_id: revoke_actor.user_id }
        : {
            employee_id:
              actor && actor.employee_id !== null && actor.employee_id !== undefined && Number(actor.employee_id) > 0
                ? Number(actor.employee_id)
                : null,
            user_id: actor && actor.user_id !== undefined ? actor.user_id : null,
          };

    const results = [];
    // Every employee/month a decision in this batch rewrote, refreshed ONCE
    // after the loop - fifty approvals for one employee's month are one
    // month persist, not fifty.
    const monthRefreshEntries = [];
    /* eslint-disable no-await-in-loop */
    // ONE AT A TIME, on purpose: each record is its own transaction, and two
    // records of the same employee and date must not race each other's
    // recalculation.
    for (const target of targets) {
      const result = {
        request_id: target.request_id,
        request_type: null,
        employee_id: null,
        attendance_date: null,
        previous_status: null,
        new_status: null,
        outcome: null,
        code: null,
        message: null,
      };
      try {
        const request = await attendanceRegularizationRepo.getRequest(target.request_id);
        if (!request) {
          Object.assign(result, { outcome: BULK_OUTCOME.SKIPPED, code: "NOT_FOUND", message: "No such request" });
        } else {
          result.request_type = request.request_type;
          result.employee_id = Number(request.requested_for_employee_id);
          result.attendance_date = request.attendance_date;
          result.previous_status = request.status;
          const seenStage = target.current_stage_no;
          if (!tabTypes.includes(request.request_type)) {
            Object.assign(result, {
              outcome: BULK_OUTCOME.SKIPPED,
              code: "WRONG_TYPE",
              message: `This is a ${request.request_type} request, not one of this tab's`,
            });
          } else if (action !== BULK_ACTION.REVOKE && request.status !== REQUEST_STATUS.PENDING) {
            Object.assign(result, {
              outcome: BULK_OUTCOME.FAILED,
              code: "STATE_CHANGED",
              message: `The request is now ${request.status} - it was not changed`,
            });
          } else if (
            action !== BULK_ACTION.REVOKE &&
            seenStage !== null &&
            Number(request.current_stage_no) !== seenStage
          ) {
            Object.assign(result, {
              outcome: BULK_OUTCOME.FAILED,
              code: "STATE_CHANGED",
              message: `The request moved from stage ${seenStage} to stage ${request.current_stage_no} since it was loaded - it was not changed`,
            });
          } else if (
            action === BULK_ACTION.REVOKE &&
            request.status !== REQUEST_STATUS.APPROVED &&
            request.status !== REQUEST_STATUS.REJECTED
          ) {
            Object.assign(result, {
              outcome: BULK_OUTCOME.FAILED,
              code: "STATE_CHANGED",
              message: `The request is now ${request.status} - it was not changed`,
            });
          } else if (action === BULK_ACTION.REVOKE && target.status && target.status !== request.status) {
            Object.assign(result, {
              outcome: BULK_OUTCOME.FAILED,
              code: "STATE_CHANGED",
              message: `The request was ${target.status} when loaded and is now ${request.status} - it was not changed`,
            });
          } else {
            // THE SINGLE-RECORD ACTION, unchanged.
            const done =
              action === BULK_ACTION.REVOKE
                ? await revokeDecision({
                    actor: revoke_actor,
                    request_id: target.request_id,
                    reason: why,
                    now,
                    month_refresh_collector: monthRefreshEntries,
                  })
                : await decide({
                    actor,
                    request_id: target.request_id,
                    decision: action === BULK_ACTION.APPROVE ? STEP_DECISION.APPROVED : STEP_DECISION.REJECTED,
                    remarks: why || null,
                    source: "WEB",
                    now,
                    month_refresh_collector: monthRefreshEntries,
                  });
            if (done && done.code === 200) {
              Object.assign(result, {
                outcome: BULK_OUTCOME.SUCCEEDED,
                code: "OK",
                new_status: done.status,
                message:
                  action === BULK_ACTION.REVOKE
                    ? done.status === REQUEST_STATUS.PENDING
                      ? `Revoked - the rejection is withdrawn and the request is back in approval at stage ${done.reopened_stage_no}`
                      : "Revoked - the request is cancelled"
                    : done.status === REQUEST_STATUS.PENDING
                    ? "Passed to the next stage"
                    : done.status === REQUEST_STATUS.APPROVED
                    ? "Finally approved"
                    : "Rejected",
              });
              if (done.current_stage_no !== undefined) result.current_stage_no = done.current_stage_no;
            } else if (done && done.code === 409 && done.reason_code) {
              // A RULE the transaction applied on the locked rows (an OT
              // claim standing on the date, a competing request) - skipped,
              // with the rule, exactly as a pre-check refusal would be.
              Object.assign(result, { outcome: BULK_OUTCOME.SKIPPED, code: done.reason_code, message: done.msg });
            } else {
              Object.assign(result, {
                outcome: BULK_OUTCOME.FAILED,
                code: done && done.code === 409 ? "STATE_CHANGED" : "ERROR",
                message: (done && done.msg) || "The request was not changed",
              });
            }
          }
        }
      } catch (err) {
        Object.assign(result, bulkRefusal(err));
      }

      // THE PER-RECORD LOG. The action has already committed or been
      // refused; a log write that fails does not undo it, and is reported.
      try {
        if (typeof attendanceRegularizationRepo.recordBulkActionItem === "function") {
          await attendanceRegularizationRepo.recordBulkActionItem({
            bulk_operation_id: operationId,
            action,
            request_id: result.request_id,
            request_type: result.request_type,
            employee_id: result.employee_id,
            attendance_date: result.attendance_date,
            previous_status: result.previous_status,
            new_status: result.new_status,
            outcome: result.outcome,
            outcome_reason: result.outcome === BULK_OUTCOME.SUCCEEDED ? null : result.message,
            reason: why || null,
            acted_by_employee_id: logActor.employee_id,
            acted_by_user_id: logActor.user_id,
          });
          result.logged = true;
        } else {
          result.logged = false;
        }
      } catch (err) {
        result.logged = false;
      }
      results.push(result);
    }
    /* eslint-enable no-await-in-loop */

    const summary = { requested: targets.length, succeeded: 0, skipped: 0, failed: 0 };
    results.forEach((r) => {
      if (r.outcome === BULK_OUTCOME.SUCCEEDED) summary.succeeded += 1;
      else if (r.outcome === BULK_OUTCOME.SKIPPED) summary.skipped += 1;
      else summary.failed += 1;
    });
    const monthRefresh =
      monthRefreshEntries.length > 0
        ? await refreshMonthsAfter(monthRefreshEntries, { now, source: `a bulk ${action}` })
        : null;

    return { code: 200, bulk_operation_id: operationId, action, request_type, summary, results, month_refresh: monthRefresh };
  };

  /**
   * "SELECT ALL MATCHING THE FILTERS": the requests of one tab, under the
   * caller's own scope and the screen's filters, that this caller could put
   * through `action` right now - the same query as the list, then the same
   * test the row shows (`actionable` for Approve / Reject, `revocable` for
   * Revoke). Only ids and the state to check them against are returned; the
   * bulk action re-reads and re-checks every one of them anyway.
   */
  const listBulkTargets = async ({
    actor,
    request_type,
    status,
    action,
    outlet_ids = null,
    employee_id = null,
    designation_id = null,
  }) => {
    if (!APPROVAL_TYPES.includes(request_type)) {
      throw validationError("request_type must be REGULARIZATION, OT, SHIFT_CHANGE or PERMISSION");
    }
    if (!Object.values(BULK_ACTION).includes(action)) {
      throw validationError("action must be APPROVE, REJECT or REVOKE");
    }
    const wanted = action === BULK_ACTION.REVOKE ? ["APPROVED", "REJECTED"] : ["PENDING"];
    if (!wanted.includes(status)) {
      throw validationError(`${action} applies to ${wanted.join(" or ")} requests`);
    }
    const isAdmin = Number(actor.user_type) === ADMIN_USER_TYPE;
    if (action === BULK_ACTION.REVOKE && (!isAdmin || !REVOCABLE_TYPES.some((t) => typesForTab(request_type).includes(t)))) {
      return { items: [], total: 0, truncated: false };
    }
    const identity = await resolveIdentity(actor.employee_id);
    const scope = {
      request_type: typesForTab(request_type),
      status,
      approver_roles: rolesFor(identity, actor),
      outlet_id: identity.outlet_id,
      actor_employee_id: identity.employee_id,
      is_admin: isAdmin,
      ...screenFilters({ actor, outlet_ids, employee_id, designation_id }),
    };
    const [rows, total] = await Promise.all([
      attendanceRegularizationRepo.listApprovals({ ...scope, limit: MAX_BULK_TARGETS, offset: 0 }),
      attendanceRegularizationRepo.countApprovals(scope),
    ]);
    let eligible;
    if (action === BULK_ACTION.REVOKE) {
      eligible = rows.filter((row) => REVOCABLE_TYPES.includes(row.request_type) && !row.closure_reason);
    } else {
      const steps = await attendanceRegularizationRepo.listStepsForRequests(
        rows.map((r) => Number(r.attendance_approval_request_id))
      );
      const byId = new Map(rows.map((r) => [Number(r.attendance_approval_request_id), r]));
      const current = new Map();
      steps.forEach((st) => {
        const id = Number(st.attendance_approval_request_id);
        const row = byId.get(id);
        if (row && Number(st.stage_no) === Number(row.current_stage_no)) current.set(id, st);
      });
      eligible = rows.filter((row) => {
        const step = current.get(Number(row.attendance_approval_request_id));
        return (
          step &&
          canApprove(
            step,
            {
              employee_id: identity.employee_id,
              user_type: actor.user_type,
              outlet_id: identity.outlet_id,
              approver_roles: identity.approver_roles,
            },
            row
          ).allowed
        );
      });
    }
    return {
      items: eligible.map((row) => ({
        request_id: Number(row.attendance_approval_request_id),
        current_stage_no: Number(row.current_stage_no),
        status: row.status,
      })),
      total: Number(total) || 0,
      truncated: Number(total) > rows.length,
    };
  };

  /** "Pending with me", counted in SQL for one request type. */
  const countPending = async ({
    actor,
    request_type,
    outlet_ids = null,
    employee_id = null,
    designation_id = null,
  }) => {
    if (!APPROVAL_TYPES.includes(request_type)) {
      throw validationError("request_type must be REGULARIZATION, OT, SHIFT_CHANGE or PERMISSION");
    }
    const identity = await resolveIdentity(actor.employee_id);
    // "Pending with me" is counted under THE SAME filters the list is showing,
    // so the number over a filtered table is a count of that table and not of
    // something the reader cannot see.
    const count = await attendanceRegularizationRepo.countApprovals({
      request_type: typesForTab(request_type),
      status: "PENDING",
      approver_roles: rolesFor(identity, actor),
      outlet_id: identity.outlet_id,
      actor_employee_id: identity.employee_id,
      is_admin: Number(actor.user_type) === ADMIN_USER_TYPE,
      ...screenFilters({ actor, outlet_ids, employee_id, designation_id }),
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
    raiseShiftChangeRequest,
    shiftChangeOptions,
    shiftChangeEligibilityFor,
    activeBlockFor,
    setShiftChangeNotifier,
    setOtNotifier,
    syncAutoOt,
    syncAutoOtSafely,
    otApprovalContext,
    AUTO_OT_SKIP,
    MAX_FORWARD_DAYS,
    closeOtForPayrollLock,
    raisePermissionRequest,
    decide,
    revokeDecision,
    REVOCABLE_TYPES,
    bulkAction,
    listBulkTargets,
    BULK_ACTION,
    BULK_OUTCOME,
    MAX_BULK_ITEMS,
    listApprovals,
    countPending,
    listPending,
    listForEmployee,
    getRequest,
  };
};
