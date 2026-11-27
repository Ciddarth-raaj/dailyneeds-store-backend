/**
 * Stock Audit - one vocabulary for "do we know this value?".
 *
 * Missing information is NEVER shown or calculated as 0 or 100%. Every figure
 * a Stock Audit endpoint returns that may be unknown travels as a cell:
 *
 *   { status: "AVAILABLE",      value: 1234 }
 *   { status: "PENDING",        value: null, reason: "PENDING_VERIFICATION" }   expected, not yet in
 *   { status: "UNAVAILABLE",    value: null, reason: "ALLOTMENT_UNAVAILABLE" }  the source does not provide it
 *   { status: "NOT_APPLICABLE", value: null, reason: "NO_ARTICLES" }            the question does not arise
 *
 * Only AVAILABLE carries a value. The web app renders the other three as
 * labelled badges, never as a number.
 */

const STATUS = Object.freeze({
  AVAILABLE: "AVAILABLE",
  PENDING: "PENDING",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

const REASON = Object.freeze({
  ALLOTMENT_UNAVAILABLE: "ALLOTMENT_UNAVAILABLE",
  RECOUNT_DATA_PENDING: "RECOUNT_DATA_PENDING",
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  INSUFFICIENT_SAMPLE: "INSUFFICIENT_SAMPLE",
  PENDING_ELIGIBILITY_REVIEW: "PENDING_ELIGIBILITY_REVIEW",
  POLICY_NOT_APPROVED: "POLICY_NOT_APPROVED",
  NO_ARTICLES: "NO_ARTICLES",
  NO_VARIANCES: "NO_VARIANCES",
  NO_DATA: "NO_DATA",
  COMPONENT_PENDING: "COMPONENT_PENDING",
  INDEPENDENT_VERIFICATION_PENDING: "INDEPENDENT_VERIFICATION_PENDING",
  INDEPENDENT_VERIFICATION_NOT_DONE: "INDEPENDENT_VERIFICATION_NOT_DONE",
  OUTSIDE_PROGRAMME: "OUTSIDE_PROGRAMME",
  BEFORE_DEADLINE: "BEFORE_DEADLINE",
  NOT_APPROVED: "NOT_APPROVED",
  HEADCOUNT_UNAVAILABLE: "HEADCOUNT_UNAVAILABLE",
  ROLE_NOT_ASSIGNED: "ROLE_NOT_ASSIGNED",
  EMPLOYEE_UNMAPPED: "EMPLOYEE_UNMAPPED",
});

const available = (value) => ({ status: STATUS.AVAILABLE, value });
const pending = (reason) => ({ status: STATUS.PENDING, value: null, reason });
const unavailable = (reason) => ({ status: STATUS.UNAVAILABLE, value: null, reason });
const notApplicable = (reason) => ({ status: STATUS.NOT_APPLICABLE, value: null, reason });

const isKnown = (cell) => Boolean(cell) && cell.status === STATUS.AVAILABLE;

module.exports = { STATUS, REASON, available, pending, unavailable, notApplicable, isKnown };
