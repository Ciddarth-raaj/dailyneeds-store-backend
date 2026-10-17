/**
 * THE REHIRE GATE - what a rejoin needs, given the rehire assessment of the
 * exit it rejoins from. PURE: plain values in, a decision out.
 *
 *   no assessment / YES   the ordinary rejoin, unchanged
 *   CONDITIONAL           management approval: `approve_rehire_exception`
 *                         and a reason (which records how the conditions
 *                         are met)
 *   NO                    management override: the same key and a
 *                         mandatory reason
 *
 * The decision is enforced in the backend, inside the rejoin transaction
 * (`usecase/employee_master.js#rejoinEmployee`), never only on a screen.
 */
const REHIRE_EXCEPTION_REASON_MIN = 10;
const REHIRE_EXCEPTION_REASON_MAX = 500;

/**
 * @param {object} args
 * @param {object|null} args.assessment  the newest assessment of the exit, or null
 * @param {boolean} args.canApprove      caller holds approve_rehire_exception
 * @param {string|null} args.reason      the reason sent with the rejoin
 * @returns {{ allowed: boolean, exception: boolean, code?: string, message?: string }}
 */
function decideRehire({ assessment = null, canApprove = false, reason = null } = {}) {
  const eligibility = assessment ? assessment.eligibility : null;
  if (!eligibility || eligibility === "YES") return { allowed: true, exception: false };
  const what =
    eligibility === "NO"
      ? "assessed as NOT fit for rehire at their previous exit. Rejoining needs a management override with a reason"
      : "assessed as fit for rehire only on CONDITIONS at their previous exit. Rejoining needs management approval with a reason";
  if (!canApprove) {
    return {
      allowed: false,
      exception: true,
      code: "REHIRE_APPROVAL_REQUIRED",
      message: `This employee was ${what} (Approve Rehire Exception permission).`,
    };
  }
  const why = reason === null || reason === undefined ? "" : String(reason).trim();
  if (why.length < REHIRE_EXCEPTION_REASON_MIN || why.length > REHIRE_EXCEPTION_REASON_MAX) {
    return {
      allowed: false,
      exception: true,
      code: "REHIRE_REASON_REQUIRED",
      message: `This employee was ${what}. Give a reason of ${REHIRE_EXCEPTION_REASON_MIN}-${REHIRE_EXCEPTION_REASON_MAX} characters.`,
    };
  }
  return { allowed: true, exception: true, eligibility, reason: why };
}

module.exports = { decideRehire, REHIRE_EXCEPTION_REASON_MIN, REHIRE_EXCEPTION_REASON_MAX };
