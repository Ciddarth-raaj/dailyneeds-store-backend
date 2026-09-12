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
 * ONE PASS FOR ONE DATE. A date that has both a missing punch and resulting
 * overtime raises ONE request, of type REGULARIZATION_WITH_OT, and the final
 * approval on that single chain approves both. OT with no missing punch raises
 * an OT request and still walks the same chain: v2 approves overtime after the
 * work, never before it, and never by a different route.
 *
 * WHY THERE IS NO PER-EMPLOYEE APPROVER TABLE. The chain is a function of role
 * and outlet, and the current architecture has no genuine per-employee
 * approver overrides to preserve. Building a per-employee matrix would be
 * inventing a requirement; if one ever appears, it belongs beside this
 * function rather than inside it.
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
 * and only then does its regularized punch become effective and its OT become
 * payable - which is the entire point of the chain.
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
