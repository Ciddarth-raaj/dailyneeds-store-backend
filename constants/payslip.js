/**
 * Payslip Publish + Telegram notification + Mini App "My Payslips".
 *
 * A payslip is an IMMUTABLE SNAPSHOT of the stored approved calculation,
 * frozen at Publish. These are its fixed vocabularies.
 */

/** The snapshot's own shape. Bump when the JSON layout changes. */
const SNAPSHOT_SCHEMA_VERSION = 1;

/** The renderer the snapshot was frozen for (Mini App detail + PDF). */
const TEMPLATE_VERSION = "payslip-v1";

const PAYSLIP_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
});

/** Stored per attempt (QUEUED -> SENDING -> outcome). NOT_ATTEMPTED is derived: no attempt row. */
const NOTIFICATION_RESULT = Object.freeze({
  QUEUED: "QUEUED",
  SENDING: "SENDING",
  SENT: "SENT",
  FAILED: "FAILED",
  NO_TELEGRAM_LINK: "NO_TELEGRAM_LINK",
  NOT_ATTEMPTED: "NOT_ATTEMPTED",
});

const NOTIFICATION_TRIGGER = Object.freeze({
  PUBLISH: "PUBLISH",
  RETRY: "RETRY",
});

/** Payslip archive reason when Unpublish gives none (Unpublish requires one). */
const ARCHIVE_REASON_MAX = 500;

/**
 * THE ONLY TEXT THE EMPLOYEE RECEIVES ON TELEGRAM. No figure of any kind -
 * not the Net Pay, not a deduction, not a day count. The month is the only
 * variable, and it is built from two integers.
 */
const MONTH_NAMES = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);
const MONTH_SHORT = Object.freeze([
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]);

function monthLabel(year, month) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) return "";
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function notificationText(year, month) {
  return `Your payslip for ${monthLabel(year, month)} is now available in My Payslips.`;
}

/** Concurrent Telegram sends during a bulk publish / retry. */
const NOTIFY_CONCURRENCY = 5;
/** Per-message ceiling, so one stuck call cannot hold a batch. */
const NOTIFY_TIMEOUT_MS = 10000;

/** Concurrent on-demand PDF renders across the whole process. */
const PDF_RENDER_CONCURRENCY = 2;

/** Lifetime of a single-use Mini App PDF download link (Telegram downloadFile fetches it). */
const PDF_LINK_TTL_SECONDS = 60;

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  TEMPLATE_VERSION,
  PAYSLIP_STATUS,
  NOTIFICATION_RESULT,
  NOTIFICATION_TRIGGER,
  ARCHIVE_REASON_MAX,
  MONTH_NAMES,
  MONTH_SHORT,
  monthLabel,
  notificationText,
  NOTIFY_CONCURRENCY,
  NOTIFY_TIMEOUT_MS,
  PDF_RENDER_CONCURRENCY,
  PDF_LINK_TTL_SECONDS,
};
