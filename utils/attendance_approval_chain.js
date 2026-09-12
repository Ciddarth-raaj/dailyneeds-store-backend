/**
 * Attendance v2 / A3 - who has to approve, and in what order.
 *
 * PURE FUNCTIONS ONLY. No database, no Express, no clock. The caller supplies
 * the requester's classification and the actor's roles; everything here is a
 * decision about those two facts, which is what lets the whole chain be tested
 * exhaustively without a MySQL instance.
 *
 * THE CHAINS, exactly as approved in v2:
 *
 *   Store employee   own Store Manager -> Operations Manager -> HR
 *   Manager          Operations Manager -> HR
 *   Head             Admin
 *
 * A STORE MANAGER NEVER APPROVES THEIR OWN REQUEST. Their own regularization
 * follows the Manager chain instead, so the first approver is somebody else by
 * construction rather than by a check that could be forgotten. The more
 * general rule - nobody approves their own request, whatever their role - is
 * enforced separately in `canApprove`, because a Store Manager is not the only
 * person who could otherwise appear in their own chain.
 *
 * TWO REQUESTS FOR TWO THINGS. A missing punch raises a REGULARIZATION, whose
 * approval corrects attendance only; overtime the corrected day earns is then
 * requested by the employee as a separate OT request, which walks the same
 * chain: v2 approves overtime after the work, never before it, and never by a
 * different route. REGULARIZATION_WITH_OT is a legacy type kept so historical
 * rows still read; `requestTypeFor` still names it for them, and new code
 * never creates it.
 *
 * THE EMPLOYEE-LEVEL CHAIN (Attendance Approver Setup). A per-employee
 * mapping now exists beside the role chain, exactly where the earlier note
 * said it would belong: First Level -> Second Level -> Final Approver, each an
 * EMPLOYEE ID, First and Second optional and skipped when blank, Final
 * mandatory and always the last stage. `buildEmployeeApprovalChain` turns one
 * mapping into steps whose `approver_role` is the marker EMPLOYEE and whose
 * `approver_employee_id` is the snapshotted person; `canApprove` lets exactly
 * that person (or an administrator, recorded as an override) decide it. A
 * request resolves ONE chain at creation - employee-level when the requester
 * has an active mapping, the role chain above otherwise - and never mixes the
 * two.
 */

/** What the REQUESTER is, which decides which chain applies. */
const REQUESTER_CLASS = Object.freeze({
  STORE_EMPLOYEE: "STORE_EMPLOYEE",
  MANAGER: "MANAGER",
  HEAD: "HEAD",
});

/** What an APPROVER holds. Held by explicit mapping only - never inferred. */
const APPROVER_ROLE = Object.freeze({
  STORE_MANAGER: "STORE_MANAGER",
  OPERATIONS_MANAGER: "OPERATIONS_MANAGER",
  HR: "HR",
  ADMIN: "ADMIN",
});

/**
 * The marker on a step addressed to a PERSON rather than to a role. Kept out
 * of APPROVER_ROLE on purpose: nobody "holds" it, so it can never be granted,
 * inferred or handed to an administrator's role list.
 */
const EMPLOYEE_STAGE_ROLE = "EMPLOYEE";

/** The three explicit levels of an employee-level mapping. Always all three. */
const APPROVAL_LEVEL = Object.freeze({
  FIRST: "FIRST",
  SECOND: "SECOND",
  FINAL: "FINAL",
});

/** Which chain a request snapshotted. */
const CHAIN_SOURCE = Object.freeze({
  ROLE: "ROLE",
  EMPLOYEE: "EMPLOYEE",
});

/** What a request is about. */
const REQUEST_TYPE = Object.freeze({
  REGULARIZATION: "REGULARIZATION",
  OT: "OT",
  REGULARIZATION_WITH_OT: "REGULARIZATION_WITH_OT",
});

const REQUEST_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

const STEP_DECISION = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  SKIPPED: "SKIPPED",
});

/** `user_type` 2 is an administrator account, as everywhere else in this backend. */
const ADMIN_USER_TYPE = 2;

/**
 * The ordered chain for one request.
 *
 * `outlet_id` is carried on the Store Manager stage only, because that is the
 * one role whose authority is scoped: the manager of DN3 approves DN3's staff
 * and nobody else's. Operations, HR and Admin are company-wide and carry null.
 *
 * @param {object} input
 * @param {string} input.requester_class     one of REQUESTER_CLASS
 * @param {number|null} input.outlet_id      the requester's home outlet
 * @param {boolean} [input.requester_is_store_manager]
 * @returns {Array<{stage_no: number, approver_role: string, outlet_id: number|null}>}
 */
function buildApprovalChain({
  requester_class,
  outlet_id = null,
  requester_is_store_manager = false,
}) {
  // A Store Manager's own request cannot start with the Store Manager stage,
  // because that stage would be themselves. It becomes a Manager chain.
  const effective =
    requester_is_store_manager && requester_class === REQUESTER_CLASS.STORE_EMPLOYEE
      ? REQUESTER_CLASS.MANAGER
      : requester_class;

  const roles =
    effective === REQUESTER_CLASS.HEAD
      ? [APPROVER_ROLE.ADMIN]
      : effective === REQUESTER_CLASS.MANAGER
        ? [APPROVER_ROLE.OPERATIONS_MANAGER, APPROVER_ROLE.HR]
        : [APPROVER_ROLE.STORE_MANAGER, APPROVER_ROLE.OPERATIONS_MANAGER, APPROVER_ROLE.HR];

  return roles.map((approver_role, index) => ({
    stage_no: index + 1,
    approver_role,
    outlet_id: approver_role === APPROVER_ROLE.STORE_MANAGER ? outlet_id : null,
  }));
}

const idOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

/**
 * Validate one employee's approver mapping. PURE: the caller supplies which
 * ids exist and which are active.
 *
 * Rules, and only these: the employee exists; the Final Approver is present;
 * every named approver exists; a NEWLY assigned approver is active (an
 * approver already on the row who has since resigned is the Replace
 * Approver's business, not a reason to refuse an unrelated edit); nobody is
 * their own approver at any level. Nothing about designations, and nothing
 * forcing First or Second to be filled.
 *
 * @param {object} setup {employee_id, first_level_approver_employee_id,
 *                        second_level_approver_employee_id, final_approver_employee_id}
 * @param {object} facts {exists: (id) => boolean, isActive: (id) => boolean,
 *                        previous?: {first..., second..., final...}}
 * @returns {{ok: boolean, errors: string[], normalized: object|null}}
 */
function validateApproverSetup(setup, facts) {
  const errors = [];
  const exists = (id) => !!(facts && typeof facts.exists === "function" && facts.exists(id));
  const isActive = (id) => !!(facts && typeof facts.isActive === "function" && facts.isActive(id));
  const previous = (facts && facts.previous) || {};

  const employeeId = idOrNull(setup && setup.employee_id);
  if (employeeId === null || Number.isNaN(employeeId)) errors.push("employee_id must be an employee id");
  else if (!exists(employeeId)) errors.push(`No such employee: ${employeeId}`);

  const levels = [
    ["first_level_approver_employee_id", "First Level Approver", APPROVAL_LEVEL.FIRST],
    ["second_level_approver_employee_id", "Second Level Approver", APPROVAL_LEVEL.SECOND],
    ["final_approver_employee_id", "Final Approver", APPROVAL_LEVEL.FINAL],
  ];
  const normalized = { employee_id: employeeId };
  levels.forEach(([key, label, level]) => {
    const id = idOrNull(setup ? setup[key] : null);
    if (Number.isNaN(id)) {
      errors.push(`${label} must be an employee id`);
      normalized[key] = null;
      return;
    }
    normalized[key] = id;
    if (id === null) {
      if (level === APPROVAL_LEVEL.FINAL) errors.push("Final Approver is required");
      return;
    }
    if (!exists(id)) {
      errors.push(`${label}: no such employee ${id}`);
      return;
    }
    if (employeeId !== null && id === employeeId) {
      errors.push(`${label}: an employee cannot be their own approver`);
    }
    // Active is required of anybody NEWLY placed on the row.
    const unchanged = idOrNull(previous[key]) === id;
    if (!unchanged && !isActive(id)) {
      errors.push(`${label}: employee ${id} is not active and cannot be newly assigned as an approver`);
    }
  });

  return { ok: errors.length === 0, errors, normalized: errors.length === 0 ? normalized : null };
}

/**
 * The ordered EMPLOYEE-LEVEL chain for one mapping.
 *
 * Blank optional levels are skipped, so the stage numbers are dense and the
 * Final Approver is always the last stage:
 *   First + Second + Final -> 1, 2, 3     Second + Final -> 1, 2
 *   First + Final          -> 1, 2        Final only     -> 1
 *
 * Every step carries the marker role EMPLOYEE, no outlet, the actual approver
 * employee id and the level it came from. Throws when Final is missing: a
 * mapping without a final authority is not a chain.
 */
function buildEmployeeApprovalChain(setup) {
  const finalId = idOrNull(setup && setup.final_approver_employee_id);
  if (finalId === null || Number.isNaN(finalId)) {
    throw new Error("An employee-level chain needs a Final Approver");
  }
  const ordered = [
    [APPROVAL_LEVEL.FIRST, idOrNull(setup.first_level_approver_employee_id)],
    [APPROVAL_LEVEL.SECOND, idOrNull(setup.second_level_approver_employee_id)],
    [APPROVAL_LEVEL.FINAL, finalId],
  ].filter(([, id]) => id !== null && !Number.isNaN(id));

  return ordered.map(([approval_level, approver_employee_id], index) => ({
    stage_no: index + 1,
    approver_role: EMPLOYEE_STAGE_ROLE,
    outlet_id: null,
    approver_employee_id,
    approval_level,
  }));
}

/** Is this step addressed to a person (employee-level) rather than a role? */
const isEmployeeStep = (step) =>
  !!step &&
  (step.approver_role === EMPLOYEE_STAGE_ROLE ||
    (step.approver_employee_id !== null && step.approver_employee_id !== undefined));

/**
 * The request type for a date, from what the date actually needs.
 *
 * One date, one request, one pass - so a missing punch that also produces
 * overtime is never two queues and two decisions.
 */
function requestTypeFor({ has_missing_punch = false, has_candidate_ot = false }) {
  if (has_missing_punch && has_candidate_ot) return REQUEST_TYPE.REGULARIZATION_WITH_OT;
  if (has_missing_punch) return REQUEST_TYPE.REGULARIZATION;
  return REQUEST_TYPE.OT;
}

/**
 * May `actor` decide `step`?
 *
 * @param {object} step   {stage_no, approver_role, outlet_id, decision}
 * @param {object} actor  {employee_id, user_type, outlet_id, approver_roles: []}
 * @param {object} request {requested_for_employee_id, requested_by_employee_id, status,
 *                          current_stage_no}
 * @returns {{allowed: boolean, reason: string|null, as_admin_override: boolean}}
 */
function canApprove(step, actor, request) {
  const deny = (reason) => ({ allowed: false, reason, as_admin_override: false });

  if (!step || !actor || !request) return deny("Missing step, actor or request");
  if (request.status !== REQUEST_STATUS.PENDING) {
    return deny(`This request is already ${String(request.status).toLowerCase()}`);
  }
  if (Number(step.stage_no) !== Number(request.current_stage_no)) {
    return deny("An earlier stage of this request has not been decided yet");
  }
  if (step.decision && step.decision !== STEP_DECISION.PENDING) {
    return deny("This stage has already been decided");
  }

  const actorId = Number(actor.employee_id);
  // NOBODY approves their own request, in any role, at any stage, including an
  // administrator. Both the subject of the request and the person who raised
  // it are excluded - a manager raising a correction on their own attendance
  // is the same conflict whichever column their id is in.
  if (actorId === Number(request.requested_for_employee_id)) {
    return deny("You cannot approve a request about your own attendance");
  }
  if (actorId === Number(request.requested_by_employee_id)) {
    return deny("You cannot approve a request you raised yourself");
  }

  const roles = Array.isArray(actor.approver_roles) ? actor.approver_roles : [];
  const isAdmin = Number(actor.user_type) === ADMIN_USER_TYPE;

  // An EMPLOYEE-LEVEL stage is decided by the one person snapshotted onto it.
  // Roles do not enter into it: a Store Manager who is not that person cannot
  // decide it, and neither can the same person acting under a different
  // designation later. Only the administrator override applies, and it is
  // recorded as such.
  if (isEmployeeStep(step)) {
    if (actorId === Number(step.approver_employee_id)) {
      return { allowed: true, reason: null, as_admin_override: false };
    }
    if (isAdmin) return { allowed: true, reason: null, as_admin_override: true };
    return deny("This stage must be decided by its assigned approver");
  }

  if (roles.includes(step.approver_role)) {
    // A Store Manager's authority is scoped to their own outlet. Operations,
    // HR and Admin are company-wide, and their stages carry no outlet.
    if (step.approver_role === APPROVER_ROLE.STORE_MANAGER) {
      if (step.outlet_id === null || step.outlet_id === undefined) {
        return deny("This request has no outlet, so no Store Manager stage can be decided");
      }
      if (Number(actor.outlet_id) !== Number(step.outlet_id)) {
        return deny("A Store Manager may only decide requests from their own outlet");
      }
    }
    return { allowed: true, reason: null, as_admin_override: false };
  }

  // Administrators may act on any stage, as they may everywhere else in this
  // backend (the permission middleware bypasses the table entirely for
  // user_type 2). It is recorded as an override on the audit step rather than
  // passed off as an ordinary approval, so a chain an administrator short-cut
  // is visible as such afterwards.
  if (isAdmin) {
    return { allowed: true, reason: null, as_admin_override: true };
  }

  return deny(`This stage must be decided by ${step.approver_role.replace(/_/g, " ").toLowerCase()}`);
}

/**
 * Advance a request after one stage has been decided.
 *
 * A rejection ends the whole request immediately: there is no "reject and pass
 * it on". An approval at the last stage is what makes the request APPROVED,
 * and only then does a regularization's punch become effective, or an OT
 * request's approved minutes become payable - which is the entire point of
 * the chain. The two are separate requests; an attendance approval never
 * approves OT.
 *
 * Pure: it returns the new state and writes nothing.
 */
function advance(request, chain, decision) {
  if (decision === STEP_DECISION.REJECTED) {
    return { status: REQUEST_STATUS.REJECTED, current_stage_no: request.current_stage_no };
  }
  const next = Number(request.current_stage_no) + 1;
  if (next > chain.length) {
    return { status: REQUEST_STATUS.APPROVED, current_stage_no: chain.length };
  }
  return { status: REQUEST_STATUS.PENDING, current_stage_no: next };
}

/**
 * Is this request's outcome allowed to reach payroll?
 *
 * The one question A4 asks. Only a fully APPROVED request counts: a request
 * sitting at stage 2 of 3 contributes exactly zero payable OT and its
 * regularized punch is not part of the effective punch list.
 */
const isFinallyApproved = (request) =>
  !!request && request.status === REQUEST_STATUS.APPROVED;

module.exports = {
  REQUESTER_CLASS,
  APPROVER_ROLE,
  EMPLOYEE_STAGE_ROLE,
  APPROVAL_LEVEL,
  CHAIN_SOURCE,
  validateApproverSetup,
  buildEmployeeApprovalChain,
  isEmployeeStep,
  REQUEST_TYPE,
  REQUEST_STATUS,
  STEP_DECISION,
  ADMIN_USER_TYPE,
  buildApprovalChain,
  requestTypeFor,
  canApprove,
  advance,
  isFinallyApproved,
};
