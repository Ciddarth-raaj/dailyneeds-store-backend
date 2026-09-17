/**
 * WHAT SHOULD CHANGE - decided from claims and truth, with nothing to do
 * with Telegram, the database or the clock. Phase 3C.
 *
 * Everything hard about reconciliation is in the four rules below, and all
 * four are pure functions of "what do the claims say" and "what does the
 * business want". Keeping them here means they can be reasoned about and
 * tested without a database, a network, or a fixture that pretends to be
 * either.
 *
 * ================================== THE SOURCE-ENDING RULE =================
 *
 * A source that stops wanting somebody in a group does NOT mean the person
 * leaves. It means THAT SOURCE stops claiming them:
 *
 *   another source still ACTIVE  -> close this one at once, outcome
 *                                   RETAINED_BY_OTHER_SOURCE, and touch
 *                                   Telegram not at all. A rule expiring must
 *                                   never eject somebody a human put there.
 *   no other source              -> REMOVAL_PENDING, and cleanup follows.
 *
 * Employment ending is the exception that ends every source at once,
 * including MANUAL - see `endEmployment`.
 */
const {
  CLAIM_SOURCE,
  CLAIM_STATE,
  INTENT_REASON,
  CLOSE_OUTCOME,
} = require("../constants/telegram_membership_claim");

/** The actions this module can ask for. The caller performs them. */
const ACTION = {
  /** Open a claim that does not exist, or reopen a CLOSED one. */
  OPEN: "OPEN",
  /** REMOVAL_PENDING -> ACTIVE: eligibility returned before cleanup ran. */
  CANCEL_REMOVAL: "CANCEL_REMOVAL",
  /** ACTIVE -> REMOVAL_PENDING: nobody wants them here any more. */
  REQUEST_REMOVAL: "REQUEST_REMOVAL",
  /** Straight to CLOSED without touching Telegram - another source holds. */
  CLOSE_RETAINED: "CLOSE_RETAINED",
};

const isLive = (claim) =>
  Boolean(claim) &&
  (claim.state === CLAIM_STATE.ACTIVE || claim.state === CLAIM_STATE.REMOVAL_PENDING);

const isActive = (claim) => Boolean(claim) && claim.state === CLAIM_STATE.ACTIVE;

/** The other source of the pair. RULE and MANUAL are each other's partner. */
const otherSource = (source) =>
  source === CLAIM_SOURCE.RULE ? CLAIM_SOURCE.MANUAL : CLAIM_SOURCE.RULE;

/**
 * ONE SOURCE, ONE GROUP, ONE DECISION.
 *
 * @param {object} params
 * @param {string} params.source      RULE or MANUAL
 * @param {boolean} params.desired    does this source want the membership now
 * @param {object|null} params.claim  this source's claim, or null
 * @param {object|null} params.partner the other source's claim, or null
 * @param {string} params.reason      why, when `desired` is false
 * @returns {{action: string, source: string, intent_reason?: string,
 *            close_outcome?: string}|null} null when nothing should change.
 */
function decideSource({ source, desired, claim, partner, reason }) {
  if (desired) {
    if (isActive(claim)) return null;
    if (claim && claim.state === CLAIM_STATE.REMOVAL_PENDING) {
      return { action: ACTION.CANCEL_REMOVAL, source };
    }
    return { action: ACTION.OPEN, source };
  }

  if (!isLive(claim)) return null;

  // THE PARTNER DECIDES WHETHER ANYBODY LEAVES. Only an ACTIVE partner
  // counts: one that is itself REMOVAL_PENDING is on its way out and cannot
  // keep somebody in a group.
  if (isActive(partner)) {
    return {
      action: ACTION.CLOSE_RETAINED,
      source,
      intent_reason: INTENT_REASON.RETAINED_BY_OTHER_SOURCE,
      close_outcome: CLOSE_OUTCOME.RETAINED_BY_OTHER_SOURCE,
    };
  }

  if (claim.state === CLAIM_STATE.REMOVAL_PENDING) return null; // already asked
  return {
    action: ACTION.REQUEST_REMOVAL,
    source,
    intent_reason: reason || INTENT_REASON.RULE_NO_LONGER_MATCHES,
  };
}

/**
 * ONE GROUP, BOTH SOURCES.
 *
 * `ruleDesired` comes from the Phase 3A matcher; `manualDesired` is simply
 * whether a MANUAL claim is currently ACTIVE - a manual grant is desired
 * until a human revokes it, and a transfer is not a human.
 */
function decideGroup({ ruleClaim = null, manualClaim = null, ruleDesired, reason }) {
  const decisions = [];
  const ruleDecision = decideSource({
    source: CLAIM_SOURCE.RULE,
    desired: Boolean(ruleDesired),
    claim: ruleClaim,
    partner: manualClaim,
    reason: reason || INTENT_REASON.RULE_NO_LONGER_MATCHES,
  });
  if (ruleDecision) decisions.push(ruleDecision);

  // A REVOKED MANUAL GRANT IS NEVER GIVEN BACK BY A RULE.
  //
  // An earlier revision cancelled the MANUAL removal whenever a rule still
  // matched, which read as "they are staying anyway, so nothing to do" - and
  // silently RESTORED the grant a person had deliberately revoked. The
  // revocation would then be invisible, and the day the rule stopped
  // matching they would stay in the group on the strength of a grant nobody
  // still wanted.
  //
  // What the rule legitimately decides is only whether anybody LEAVES. So
  // the revoked grant is closed - RETAINED_BY_OTHER_SOURCE, the same outcome
  // a rule gets when a grant holds it - and the person stays in the group
  // because the RULE holds them, not because the grant came back. A MANUAL
  // claim is re-opened by a person, through the Group Map, and by nothing
  // else.
  if (manualClaim && manualClaim.state === CLAIM_STATE.REMOVAL_PENDING) {
    // `ruleDesired`, NOT the rule claim's current state. The rule's own
    // decision is being taken in this same pass: a claim that reads ACTIVE
    // right now is on its way to REMOVAL_PENDING when the mapping no longer
    // matches, and treating it as a retainer would close the revoked grant
    // as "somebody else is keeping them" at the very moment nobody is - and
    // the removal that follows would then have no claim left to close.
    const ruleHolds = Boolean(ruleDesired);
    if (ruleHolds) {
      decisions.push({
        action: ACTION.CLOSE_RETAINED,
        source: CLAIM_SOURCE.MANUAL,
        intent_reason: INTENT_REASON.RETAINED_BY_OTHER_SOURCE,
        close_outcome: CLOSE_OUTCOME.RETAINED_BY_OTHER_SOURCE,
      });
    }
  }
  return decisions;
}

/**
 * EMPLOYMENT ENDED - every source ends, MANUAL included.
 *
 * This is the one place a MANUAL claim is closed without a human, and it is
 * deliberate: a manual grant says "this person, in this role, may be here",
 * and the person is no longer employed. There is no partner to retain them,
 * because the partner is ending too.
 */
function endEmployment(claims = []) {
  return claims
    .filter(isLive)
    .filter((claim) => claim.state !== CLAIM_STATE.REMOVAL_PENDING)
    .map((claim) => ({
      action: ACTION.REQUEST_REMOVAL,
      source: claim.source,
      telegram_group_id: claim.telegram_group_id,
      intent_reason: INTENT_REASON.EMPLOYMENT_ENDED,
    }));
}

/**
 * Should this employee's claims be removed from Telegram at all?
 *
 * A claim is only cleaned up when NO source still wants the membership. The
 * caller asks per group; both claims for that group are passed in.
 */
function removalWanted({ ruleClaim = null, manualClaim = null }) {
  if (isActive(ruleClaim) || isActive(manualClaim)) return false;
  return Boolean(
    (ruleClaim && ruleClaim.state === CLAIM_STATE.REMOVAL_PENDING) ||
      (manualClaim && manualClaim.state === CLAIM_STATE.REMOVAL_PENDING)
  );
}

module.exports = {
  ACTION,
  decideSource,
  decideGroup,
  endEmployment,
  removalWanted,
  isLive,
  isActive,
  otherSource,
};
