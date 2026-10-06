/**
 * Payslip Publish + Telegram notification + Mini App "My Payslips".
 *
 * A payslip is an IMMUTABLE SNAPSHOT of the stored approved calculation,
 * frozen at Publish. These are its fixed vocabularies.
 */

/**
 * The snapshot's own shape. Bump when the JSON layout changes.
 *
 * 2: full UAN / PF / ESI numbers (`statutory.uan`, `pf_number`,
 * `esi_number`), the `advance` block and the `employer_contribution` (CTC)
 * block. A version-1 snapshot has none of them and renders without them.
 *
 * 3: `employer_contribution.monthly_ctc` is the FIXED CTC of the approved
 * salary record (changes only on revision), no longer Monthly Gross plus the
 * month's contributions; `monthly_gross` leaves that block.
 */
const SNAPSHOT_SCHEMA_VERSION = 3;

/** The renderer the snapshot was frozen for (Mini App detail + PDF). */
const TEMPLATE_VERSION = "payslip-v3";

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
/*
 * THE ADMIN BULK PAYSLIP EXPORT renders at most this many PDFs per request,
 * in one browser. The screen asks batch after batch and zips them itself, so
 * every request ends well inside a proxy's read timeout however many
 * employees are exported.
 */
const MAX_PAYSLIP_EXPORT_BATCH = 25;

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
  MAX_PAYSLIP_EXPORT_BATCH,
  PDF_LINK_TTL_SECONDS,
};
