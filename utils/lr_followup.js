/**
 * LR Follow-up - the rules, kept free of SQL and Express so they can be
 * tested on their own.
 *
 * A follow-up tracks goods that have been paid for (an Advance Request reached
 * `paid`) or dispatched by a supplier on credit (a user created the LR
 * Follow-up by hand) until they are PHYSICALLY RECEIVED. Nothing else closes one: an LR number, a dispatch date,
 * a supplier's word or an expected date passing are all tracking information,
 * not receipt.
 *
 *   DISPATCH_PENDING  -> nothing says the goods have left the supplier
 *   IN_TRANSIT        -> an LR number or a dispatch date is known
 *   GOODS_RECEIVED    -> recorded on the way to CLOSED, never left standing
 *   CLOSED            -> terminal; `closure_reason` says why
 *   VERIFICATION_REQUIRED -> brought in by the go-live backfill; someone has
 *                        to say whether the goods ever arrived
 *
 * Overdue is derived (expected delivery before today, not closed), never
 * stored, so it can never disagree with the dates it comes from.
 */

/**
 * The source of a follow-up as the DATABASE names it. A manual LR Follow-up
 * is stored as 'CREDIT_PURCHASE' (with its entry in `credit_purchases`):
 * those names shipped before the manual entry replaced the Credit Purchase
 * entry, and are kept rather than migrated. The API never shows them - see
 * API_SOURCE_TYPE.
 */
const SOURCE_TYPE = Object.freeze({
  ADVANCE_REQUEST: "ADVANCE_REQUEST",
  CREDIT_PURCHASE: "CREDIT_PURCHASE",
});

/** The source of a follow-up as the API and the screens name it. */
const API_SOURCE_TYPE = Object.freeze({
  ADVANCE_REQUEST: "ADVANCE_REQUEST",
  MANUAL: "MANUAL",
});

const TO_API_SOURCE = Object.freeze({
  [SOURCE_TYPE.ADVANCE_REQUEST]: API_SOURCE_TYPE.ADVANCE_REQUEST,
  [SOURCE_TYPE.CREDIT_PURCHASE]: API_SOURCE_TYPE.MANUAL,
});

const FROM_API_SOURCE = Object.freeze({
  [API_SOURCE_TYPE.ADVANCE_REQUEST]: SOURCE_TYPE.ADVANCE_REQUEST,
  [API_SOURCE_TYPE.MANUAL]: SOURCE_TYPE.CREDIT_PURCHASE,
});

/** Database source type -> API source type (unknown values pass through). */
const toApiSourceType = (value) => TO_API_SOURCE[value] || value;

/** API source type -> database source type; undefined for anything else. */
const fromApiSourceType = (value) => FROM_API_SOURCE[value];

const STATUS = Object.freeze({
  DISPATCH_PENDING: "DISPATCH_PENDING",
  IN_TRANSIT: "IN_TRANSIT",
  GOODS_RECEIVED: "GOODS_RECEIVED",
  CLOSED: "CLOSED",
  VERIFICATION_REQUIRED: "VERIFICATION_REQUIRED",
});

/** The statuses the dashboard counts as still waiting on goods. */
const OPEN_STATUSES = Object.freeze([STATUS.DISPATCH_PENDING, STATUS.IN_TRANSIT]);

/** Nothing moves a follow-up out of these. */
const TERMINAL_STATUSES = Object.freeze([STATUS.GOODS_RECEIVED, STATUS.CLOSED]);

const CLOSURE_REASON = Object.freeze({
  GOODS_RECEIVED: "GOODS_RECEIVED",
  REFUNDED: "REFUNDED",
  ADJUSTED: "ADJUSTED",
  CANCELLED: "CANCELLED",
});

const ACTIVITY = Object.freeze({
  CREATED: "CREATED",
  FOLLOW_UP: "FOLLOW_UP",
  LR_UPDATE: "LR_UPDATE",
  EXPECTED_DELIVERY_CHANGE: "EXPECTED_DELIVERY_CHANGE",
  GOODS_RECEIVED: "GOODS_RECEIVED",
  CLOSED: "CLOSED",
  CLOSED_WITHOUT_RECEIPT: "CLOSED_WITHOUT_RECEIPT",
  BACKFILL: "BACKFILL",
  VERIFICATION_DECISION: "VERIFICATION_DECISION",
});

/**
 * What the Legacy Verification screen may decide. Only "still pending"
 * keeps the follow-up alive; every other answer closes it, with the answer
 * kept as the closure reason.
 */
const DECISION = Object.freeze({
  GOODS_RECEIVED: "GOODS_RECEIVED",
  STILL_PENDING: "STILL_PENDING",
  REFUNDED: "REFUNDED",
  ADJUSTED: "ADJUSTED",
  CANCELLED: "CANCELLED",
});

/**
 * The closure reasons that mean NO STOCK WAS RECEIVED. Reporting separates
 * these from GOODS_RECEIVED; the database refuses a receipt date or
 * receiver on any of them.
 */
const NON_RECEIPT_REASONS = Object.freeze([
  CLOSURE_REASON.REFUNDED,
  CLOSURE_REASON.ADJUSTED,
  CLOSURE_REASON.CANCELLED,
]);

/** A follow-up open for business may be closed without receipt for these. */
const NON_RECEIPT_DECISIONS = Object.freeze([
  DECISION.REFUNDED,
  DECISION.ADJUSTED,
  DECISION.CANCELLED,
]);

const PERMISSION = Object.freeze({
  VIEW: "view_lr_followup",
  UPDATE: "update_lr_followup",
  MARK_RECEIVED: "mark_lr_goods_received",
  MANAGE_LEGACY: "manage_lr_legacy_verification",
  CLOSE_WITHOUT_RECEIPT: "close_lr_followup_without_receipt",
  ALL_STORES: "lr_followup_all_stores",
  // "Create LR Follow-up" (the manual entry). The key keeps the name it
  // shipped with, so designations that were granted it keep it.
  CREATE_MANUAL: "create_credit_purchase",
});

/** Display buckets only - nothing escalates on them. */
const AGEING_BUCKETS = Object.freeze([
  { key: "0-2", label: "0–2 days", min: 0, max: 2 },
  { key: "3-5", label: "3–5 days", min: 3, max: 5 },
  { key: "6-10", label: "6–10 days", min: 6, max: 10 },
  { key: "10+", label: "More than 10 days", min: 11, max: null },
]);

/**
 * Reference prefixes the screens show: LRF-12, AR-1025. A manual follow-up
 * has no source document of its own; its LRF number is its reference.
 */
const REF_PREFIX = Object.freeze({
  FOLLOWUP: "LRF",
  [SOURCE_TYPE.ADVANCE_REQUEST]: "AR",
});

const conflict = (message) => {
  const err = new Error(message);
  err.name = "ConflictError";
  return err;
};

const notFound = (message) => {
  const err = new Error(message);
  err.name = "NotFoundError";
  return err;
};

const invalid = (message) => {
  const err = new Error(message);
  err.name = "BusinessRuleError";
  return err;
};

const isOpen = (status) => OPEN_STATUSES.includes(status);
const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

const blank = (v) => v === undefined || v === null || String(v).trim() === "";

/**
 * Does this follow-up carry anything that says the goods have left the
 * supplier? An LR number or a dispatch date is enough - neither is
 * mandatory, because some suppliers and transport methods never produce an
 * LR. The transporter alone is not dispatch: it says who will carry the
 * goods, and a manual follow-up names one before anything has moved. An
 * expected delivery date alone is a promise, not a dispatch.
 */
function hasDispatchEvidence(row) {
  if (!row) return false;
  return !blank(row.lr_no) || !blank(row.dispatch_date);
}

/**
 * The status an OPEN follow-up should hold for the dispatch information it
 * carries. A terminal or legacy follow-up is never moved by LR details.
 */
function statusForDispatch(currentStatus, row) {
  if (!isOpen(currentStatus)) return currentStatus;
  return hasDispatchEvidence(row) ? STATUS.IN_TRANSIT : STATUS.DISPATCH_PENDING;
}

/** `YYYY-MM-DD` for a Date, a date string or a DATETIME string; null if none. */
function toDateOnly(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
      value.getDate()
    ).padStart(2, "0")}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Null when either is missing. */
function daysBetween(from, to) {
  const a = toDateOnly(from);
  const b = toDateOnly(to);
  if (!a || !b) return null;
  const utc = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / 86400000);
}

/**
 * Ageing in days from the source date (paid date / manual entry date).
 * An open follow-up ages to today; a closed one stops at the day it closed.
 */
function ageingDays(row, today) {
  if (!row) return null;
  const end = isTerminal(row.status)
    ? toDateOnly(row.goods_received_at) || toDateOnly(row.closed_at) || today
    : today;
  const days = daysBetween(row.source_date, end);
  return days === null ? null : Math.max(0, days);
}

function ageingBucket(days) {
  if (days === null || days === undefined) return null;
  const found = AGEING_BUCKETS.find((b) => days >= b.min && (b.max === null || days <= b.max));
  return found ? found.key : null;
}

/** Overdue: expected delivery already behind us, and not closed. */
function isOverdue(row, today) {
  if (!row || isTerminal(row.status)) return false;
  const expected = toDateOnly(row.expected_delivery_date);
  return Boolean(expected) && expected < today;
}

/**
 * How a follow-up ended, for screens and reports: "CLOSED - GOODS_RECEIVED",
 * "CLOSED - REFUNDED", ... ; null while it is still open.
 */
function closureOutcome(row) {
  if (!row || row.status !== STATUS.CLOSED) return null;
  return `${STATUS.CLOSED} - ${row.closure_reason || "UNKNOWN"}`;
}

/** True only for a follow-up closed because the stock physically arrived. */
const isStockReceived = (row) =>
  Boolean(row) && row.status === STATUS.CLOSED && row.closure_reason === CLOSURE_REASON.GOODS_RECEIVED;

const followupRef = (id) => (id ? `${REF_PREFIX.FOLLOWUP}-${id}` : null);

function sourceRef(row) {
  if (!row) return null;
  if (row.source_type === SOURCE_TYPE.ADVANCE_REQUEST && row.advance_request_id) {
    return `${REF_PREFIX.ADVANCE_REQUEST}-${row.advance_request_id}`;
  }
  return null;
}

/** Adds the derived, never-stored fields every screen shows. */
function decorate(row, today) {
  if (!row) return row;
  const ageing = ageingDays(row, today);
  return {
    ...row,
    followup_ref: followupRef(row.lr_followup_id),
    closure_outcome: closureOutcome(row),
    stock_received: isStockReceived(row),
    source_ref: sourceRef(row),
    ageing_days: ageing,
    ageing_bucket: ageingBucket(ageing),
    is_overdue: isOverdue(row, today),
  };
}

/** The status a legacy decision leaves behind, and the closure reason. */
function outcomeForDecision(decision, row) {
  switch (decision) {
    case DECISION.STILL_PENDING:
      return {
        status: hasDispatchEvidence(row) ? STATUS.IN_TRANSIT : STATUS.DISPATCH_PENDING,
        closure_reason: null,
      };
    case DECISION.GOODS_RECEIVED:
      return { status: STATUS.CLOSED, closure_reason: CLOSURE_REASON.GOODS_RECEIVED };
    case DECISION.REFUNDED:
    case DECISION.ADJUSTED:
    case DECISION.CANCELLED:
      return { status: STATUS.CLOSED, closure_reason: decision };
    default:
      throw invalid(`Unknown decision: ${decision}`);
  }
}

module.exports = {
  SOURCE_TYPE,
  API_SOURCE_TYPE,
  toApiSourceType,
  fromApiSourceType,
  STATUS,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  CLOSURE_REASON,
  ACTIVITY,
  DECISION,
  NON_RECEIPT_DECISIONS,
  NON_RECEIPT_REASONS,
  PERMISSION,
  AGEING_BUCKETS,
  REF_PREFIX,
  conflict,
  notFound,
  invalid,
  isOpen,
  isTerminal,
  hasDispatchEvidence,
  statusForDispatch,
  toDateOnly,
  daysBetween,
  ageingDays,
  ageingBucket,
  isOverdue,
  followupRef,
  sourceRef,
  closureOutcome,
  isStockReceived,
  decorate,
  outcomeForDecision,
};
