/**
 * THE ONE RULE for "what is this employee's Telegram status", and for which
 * link attempt is the CURRENT one.
 *
 * WHY IT IS A MODULE AND NOT A METHOD. Two callers need the answer and they
 * cannot reach it the same way:
 *
 *   ONE EMPLOYEE   `usecase/employee_telegram_link.js#getStatus` - two
 *                  indexed reads for the employee whose screen is open.
 *   SIX HUNDRED    the onboarding dashboard, which draws one row per active
 *                  employee. Asking the single-employee path per row would be
 *                  the N+1 that `usecase/employee_status_summary.js` exists to
 *                  avoid.
 *
 * So the two READS differ and the DECISION does not. It lives here, is pure,
 * and is applied to the same facts either way, so the badge on a dashboard row
 * and the status on that employee's own screen cannot disagree.
 *
 * ================================ THE PRECEDENCE ==========================
 *
 *   1  AN ACTIVE IDENTITY WINS OVER EVERYTHING. A connected employee is
 *      CONNECTED even if some older link attempt ended in a mismatch; the
 *      mismatch is history the moment somebody verified.
 *   2  otherwise the CURRENT link attempt decides - mismatch, a live pending
 *      session, or nothing usable.
 *   3  no attempt at all is PENDING - which is every employee today, and is
 *      why nothing had to be backfilled.
 *
 * ========================= WHICH ATTEMPT IS "CURRENT" =====================
 *
 * `created_at` IS A TIMESTAMP, SO IT TIES. Two QR operations inside one second
 * - issue a fresh link while an older attempt is still on the row - produce
 * two rows with the same second, and `ORDER BY created_at DESC LIMIT 1` then
 * returns whichever the storage engine felt like. A manager would see a
 * mismatch that had already been superseded, or miss one that had not.
 *
 * SO THE TIE IS BROKEN BY THE LIFECYCLE, NOT BY ROW ORDER. Each attempt is
 * ranked by how current its own recorded state proves it to be:
 *
 *   7  LIVE PENDING      somebody is mid-flow with their phone in their hand.
 *                        Nothing is more current than that.
 *   6  FRESHLY ISSUED    a link that exists and has never been opened. It was
 *                        issued after everything else on the row, because
 *                        issuing it is what superseded them.
 *   5  VERIFIED          the furthest an attempt can get.
 *   4  MOBILE MISMATCH   it concluded, and it needs a human.
 *   3  OTHER CONCLUSION  refused contact, duplicate account, no longer
 *                        employed - ended, and nothing is outstanding on it.
 *   2  EXPIRED PENDING   it was opened and ran out of time.
 *   1  SUPERSEDED        a later issuance explicitly retired it. By
 *                        definition the oldest thing in any tie.
 *
 * THE RANKS ARE A TOTAL ORDER OVER THE STATES, deliberately: two rows can tie
 * only when they are in the SAME state, and then it does not matter which is
 * chosen because both produce the same answer. That is what makes the result
 * independent of the order MySQL happened to return the rows in.
 *
 * WHAT BREAKS A REMAINING TIE. When every lifecycle fact says the same thing
 * about both rows, the FIRST row wins - and both queries order by
 * `token_hash` so that "first" is stable rather than whatever the engine
 * returned. The hash is never SELECTED and never leaves the database: an
 * arbitrary discriminator is acceptable only after every meaningful fact has
 * been considered, and it does not need to be read to be sorted by.
 */

const { TELEGRAM_STATUS, PENDING_OUTCOME } = require("../constants/employee_telegram");

/**
 * What the CURRENT link attempt has come to.
 *
 * SEPARATE FROM THE STATUS, and that is the point of it. During a reconnect
 * the employee stays CONNECTED - the old identity is deliberately kept until
 * the new account verifies - so the status alone cannot tell a screen whether
 * the QR in front of it has been dealt with. This can.
 */
const LINK_ATTEMPT = Object.freeze({
  NONE: "NONE",
  PENDING: "PENDING",
  AWAITING_CONTACT: "AWAITING_CONTACT",
  MOBILE_MISMATCH: "MOBILE_MISMATCH",
  VERIFIED: "VERIFIED",
  /**
   * IT ENDED, AND NOT ON THE NUMBER. The Telegram account already belongs to
   * another employee, or the employee stopped being employed mid-flow.
   *
   * IT IS ONE WORD AND CARRIES NO REASON, deliberately. Which employee holds
   * that Telegram account is exactly what the bot refuses to say, and a screen
   * that named it would disclose from the office what the bot protects in the
   * chat. A manager needs to know the attempt is over and a fresh QR is the
   * next move; the reason is in the audit table, where it belongs.
   *
   * FAILED IS A LINK_ATTEMPT AND NEVER A TELEGRAM_STATUS. The employee's own
   * status is about whether they have a working Telegram, which a failed
   * attempt does not change: they are PENDING if they had none and CONNECTED
   * if they had one.
   */
  FAILED: "FAILED",
});

/** Outcomes that mean the attempt REACHED a conclusion of its own. */
const CONCLUDED_OUTCOMES = new Set([
  PENDING_OUTCOME.VERIFIED,
  PENDING_OUTCOME.MOBILE_MISMATCH,
  PENDING_OUTCOME.CONTACT_NOT_OWNED,
  PENDING_OUTCOME.DUPLICATE_IDENTITY,
  PENDING_OUTCOME.EMPLOYEE_INELIGIBLE,
]);

/**
 * Outcomes the attempt cannot come back from - a fresh QR is the only way on.
 *
 * `CONTACT_NOT_OWNED` IS DELIBERATELY NOT HERE. Forwarding somebody else's
 * contact card does not end the session: the usecase leaves it open precisely
 * so the employee can tap the right button, and an honest mistake should not
 * cost a fresh QR. It is treated as terminal only once the session is no
 * longer live, which is the ordinary expiry every open attempt reaches.
 */
const TERMINAL_FAILURES = new Set([
  PENDING_OUTCOME.DUPLICATE_IDENTITY,
  PENDING_OUTCOME.EMPLOYEE_INELIGIBLE,
]);

const truthy = (value) => value === true || value === 1 || value === "1";

/** How current this attempt's own recorded state proves it to be. See the header. */
function attemptRank(row) {
  if (!row) return 0;
  const outcome = row.pending_outcome === undefined ? null : row.pending_outcome;
  if (outcome === null && truthy(row.is_live)) return 7;
  if (outcome === null && truthy(row.is_unconsumed)) return 6;
  if (outcome === PENDING_OUTCOME.VERIFIED) return 5;
  if (outcome === PENDING_OUTCOME.MOBILE_MISMATCH) return 4;
  if (outcome !== null && CONCLUDED_OUTCOMES.has(outcome)) return 3;
  if (outcome === null) return 2;
  return 1; // SUPERSEDED, and anything else recorded but not a conclusion
}

/**
 * The current attempt out of however many rows share the newest second.
 *
 * Callers hand over only rows they have already narrowed to the newest
 * `created_at`; this decides between them.
 */
function pickCurrentAttempt(rows) {
  const candidates = (rows || []).filter(Boolean);
  if (candidates.length === 0) return null;
  let best = null;
  let bestRank = -1;
  for (const row of candidates) {
    const rank = attemptRank(row);
    // STRICTLY greater wins, so an equal rank keeps the row that came first.
    // Callers hand rows over in a stable order (both queries sort by
    // `token_hash`), which is what makes "first" deterministic without the
    // hash ever being selected.
    if (rank > bestRank) {
      best = row;
      bestRank = rank;
    }
  }
  return best;
}

/** What that attempt has come to, as one of LINK_ATTEMPT. */
function attemptStateOf(row) {
  if (!row) return LINK_ATTEMPT.NONE;
  const outcome = row.pending_outcome === undefined ? null : row.pending_outcome;
  if (outcome === PENDING_OUTCOME.VERIFIED) return LINK_ATTEMPT.VERIFIED;
  if (outcome === PENDING_OUTCOME.MOBILE_MISMATCH) return LINK_ATTEMPT.MOBILE_MISMATCH;
  // A LIVE SESSION IS STILL A LIVE SESSION, whatever happened during it. A
  // refused contact card leaves the session open on purpose, so somebody who
  // forwarded the wrong one can tap the right button - and until that window
  // closes the attempt is still awaiting a contact, not failed.
  if (truthy(row.is_live)) return LINK_ATTEMPT.AWAITING_CONTACT;
  if (outcome !== null && TERMINAL_FAILURES.has(outcome)) return LINK_ATTEMPT.FAILED;
  if (outcome === PENDING_OUTCOME.CONTACT_NOT_OWNED) return LINK_ATTEMPT.FAILED;
  // Superseded, expired, freshly issued: nothing is outstanding on this
  // attempt and nothing about it needs a human. A fresh QR carries on.
  return LINK_ATTEMPT.PENDING;
}

/**
 * @param {object} facts
 * @param {boolean} facts.hasActiveIdentity a live row in employee_telegram_identity
 * @param {string} facts.attempt            one of LINK_ATTEMPT
 * @returns {string} one of TELEGRAM_STATUS
 */
function deriveTelegramStatus({ hasActiveIdentity = false, attempt = LINK_ATTEMPT.NONE } = {}) {
  if (hasActiveIdentity) return TELEGRAM_STATUS.CONNECTED;
  if (attempt === LINK_ATTEMPT.MOBILE_MISMATCH) return TELEGRAM_STATUS.MOBILE_MISMATCH;
  if (attempt === LINK_ATTEMPT.AWAITING_CONTACT) return TELEGRAM_STATUS.AWAITING_CONTACT;
  return TELEGRAM_STATUS.PENDING;
}

/**
 * The whole answer for one employee, from an identity flag and the rows that
 * share the newest second. THE ONE ENTRY POINT both callers use.
 */
function resolveTelegramState({ hasActiveIdentity = false, rows = [] } = {}) {
  const current = pickCurrentAttempt(rows);
  const attempt = attemptStateOf(current);
  return {
    status: deriveTelegramStatus({ hasActiveIdentity, attempt }),
    attempt,
  };
}

/**
 * DISCONNECTED IS NOT RETURNED BY THIS RULE, and that is the deployed
 * behaviour rather than an oversight. Disconnecting retires the identity row
 * and leaves the employee needing setup again, which is exactly PENDING; the
 * constant exists in the vocabulary for a screen that wants to say
 * "disconnected" about an action it just took.
 */
const isConnected = (status) => status === TELEGRAM_STATUS.CONNECTED;

module.exports = {
  LINK_ATTEMPT,
  attemptRank,
  pickCurrentAttempt,
  attemptStateOf,
  deriveTelegramStatus,
  resolveTelegramState,
  isConnected,
};
