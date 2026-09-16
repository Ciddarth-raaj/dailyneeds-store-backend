/**
 * THE ONE RULE for "what is this employee's Telegram status".
 *
 * WHY IT IS A MODULE AND NOT A METHOD. Two callers need the answer and they
 * cannot reach it the same way:
 *
 *   ONE EMPLOYEE   `usecase/employee_telegram_link.js#getStatus` - two
 *                  indexed reads for the employee whose screen is open.
 *   SIX HUNDRED    the onboarding dashboard, which draws one row per active
 *                  employee. Asking the single-employee path per row would be
 *                  the N+1 that `usecase/employee_status_summary.js` exists to
 *                  avoid - its header counts the queries precisely because
 *                  1,260 requests to draw one screen is how the status
 *                  columns came not to exist in the first place.
 *
 * So the two READS differ - one pair of lookups versus one pair of bulk
 * queries - and the DECISION does not. It lives here, is pure, and is applied
 * to the same three facts either way, so the badge on a dashboard row and the
 * status on that employee's own screen cannot disagree.
 *
 * ================================ THE PRECEDENCE ==========================
 *
 *   1  AN ACTIVE IDENTITY WINS OVER EVERYTHING. A connected employee is
 *      CONNECTED even if some older link attempt ended in a mismatch; the
 *      mismatch is history the moment somebody verified.
 *   2  otherwise the LATEST link attempt decides, and only the latest:
 *        MOBILE_MISMATCH    it ended in a mismatch - the state the screen must
 *                           show, because it is the one that needs a human
 *        AWAITING_CONTACT   it is still open and has not expired - somebody is
 *                           mid-flow with their phone in their hand
 *        PENDING            anything else: expired, superseded, consumed
 *   3  no link attempt at all is PENDING - which is every employee today, and
 *      is why nothing had to be backfilled.
 *
 * DISCONNECTED IS NOT RETURNED BY THIS RULE, and that is the deployed
 * behaviour rather than an oversight here. Disconnecting retires the identity
 * row and leaves the employee needing setup again, which is exactly PENDING;
 * the constant exists in the vocabulary for a screen that wants to say
 * "disconnected" about an action it just took. Nothing derives it from
 * storage, and this module does not invent a way to - that would be a change
 * to the deployed status protocol, not a dashboard extension.
 *
 * WHETHER A PENDING SESSION IS STILL LIVE IS DECIDED BY THE CALLER, on
 * purpose: the single-employee path compares in JavaScript against its own
 * injected clock, and the bulk path lets MySQL compare against `NOW()` in the
 * query that already had to visit the row. Both mean the same thing - "the
 * window has not closed" - and neither can be expressed once without making
 * one of them read the other's clock.
 */

const { TELEGRAM_STATUS, PENDING_OUTCOME } = require("../constants/employee_telegram");

/**
 * @param {object} facts
 * @param {boolean} facts.hasActiveIdentity   a live row in employee_telegram_identity
 * @param {boolean} facts.latestWasMismatch   the LATEST link attempt ended MOBILE_MISMATCH
 * @param {boolean} facts.latestIsLivePending the LATEST link attempt is open and unexpired
 * @returns {string} one of TELEGRAM_STATUS
 */
function deriveTelegramStatus({
  hasActiveIdentity = false,
  latestWasMismatch = false,
  latestIsLivePending = false,
} = {}) {
  if (hasActiveIdentity) return TELEGRAM_STATUS.CONNECTED;
  if (latestWasMismatch) return TELEGRAM_STATUS.MOBILE_MISMATCH;
  if (latestIsLivePending) return TELEGRAM_STATUS.AWAITING_CONTACT;
  return TELEGRAM_STATUS.PENDING;
}

/**
 * The same rule, read off a raw latest-token row.
 *
 * `isLive` is passed in rather than computed, for the clock reason above.
 */
function statusFromRows({ hasActiveIdentity = false, latest = null, latestIsLive = false } = {}) {
  return deriveTelegramStatus({
    hasActiveIdentity,
    latestWasMismatch: Boolean(latest) && latest.pending_outcome === PENDING_OUTCOME.MOBILE_MISMATCH,
    latestIsLivePending: Boolean(latest) && latest.pending_outcome === null && latestIsLive,
  });
}

/** Connected is the only status that means an identity exists. */
const isConnected = (status) => status === TELEGRAM_STATUS.CONNECTED;

module.exports = { deriveTelegramStatus, statusFromRows, isConnected };
