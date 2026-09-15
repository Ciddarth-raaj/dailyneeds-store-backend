require("dotenv").config();

const TEST_TELEGRAM_CHAT_ID = -1002722070031;

const ALERTS_TELEGRAM_CHAT_ID =
  process.env.IS_TEST === "true" ? TEST_TELEGRAM_CHAT_ID : -1002381170220;

const ABV_TELEGRAM_CHAT_ID =
  process.env.IS_TEST === "true" ? TEST_TELEGRAM_CHAT_ID : -4800060153;

// const ALERTS_TELEGRAM_CHAT_ID = -1002722070031;

const PURCHASE_TELEGRAM_CHAT_ID =
  process.env.IS_TEST === "true" ? TEST_TELEGRAM_CHAT_ID : -4668439381;

const STOCK_CHECKER_TELEGRAM_CHAT_ID =
  process.env.IS_TEST === "true" ? TEST_TELEGRAM_CHAT_ID : -5293267648;

const OFFERS_V3_TELEGRAM_CHAT_ID = process.env.IS_TEST === "true" ? TEST_TELEGRAM_CHAT_ID : -1003706834707;

/**
 * TEMPORARY - DIGISME ATTENDANCE BRIDGE ONLY. REMOVE WITH THE BRIDGE.
 *
 * A personal chat, not a group: the DigiSME attendance sync is a ~10-day
 * stopgap until Biomax talks to dnds.co.in directly, and its alerts are for
 * one person watching one temporary integration. They do NOT belong in the
 * shared alerts group beside accounts, purchase orders and break-glass -
 * that channel is for things the whole team acts on, and a fortnight of
 * vendor-feed noise would train everyone to ignore it.
 *
 * DELETE THIS CONSTANT when direct Biomax -> dnds.co.in goes live, together
 * with usecase/digisme_attendance_sync.js, services/digisme_attendance.js
 * and the two crons in server.js. See docs/digisme-attendance-api-sync.md.
 *
 * `usecase/digisme_attendance_sync.js` (wired in server.js) is its ONLY
 * consumer, and `usecase/digisme_alert_destination.test.js` fails if
 * anything else uses it or if the DigiSME sync reaches for
 * ALERTS_TELEGRAM_CHAT_ID instead.
 *
 * UNCONDITIONAL ON PURPOSE - unlike every other id in this file, this one
 * does not fall back to TEST_TELEGRAM_CHAT_ID when IS_TEST is set. The
 * destination was given explicitly for this bridge, and whether production
 * carries an IS_TEST line is not something we could verify from the
 * repository; making these alerts depend on it could silently send them
 * somewhere nobody is watching, which is the exact failure the sync exists
 * to prevent. A non-production instance is kept quiet by CRON_DISABLED
 * (services/cron_service.js), which stops the jobs rather than redirecting
 * their alerts.
 */
const DIGISME_ATTENDANCE_ALERT_CHAT_ID = 1933231677;

module.exports = {
  ALERTS_TELEGRAM_CHAT_ID,
  PURCHASE_TELEGRAM_CHAT_ID,
  ABV_TELEGRAM_CHAT_ID,
  TEST_TELEGRAM_CHAT_ID,
  STOCK_CHECKER_TELEGRAM_CHAT_ID,
  OFFERS_V3_TELEGRAM_CHAT_ID,
  // Temporary; see the comment above. Goes when the bridge goes.
  DIGISME_ATTENDANCE_ALERT_CHAT_ID,
};
