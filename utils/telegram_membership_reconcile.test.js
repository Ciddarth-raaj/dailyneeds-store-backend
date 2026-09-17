/**
 * THE SOURCE-ENDING RULE, in isolation. Phase 3C.
 *
 *   node --test utils/telegram_membership_reconcile.test.js
 *
 * The rule that is easy to get wrong and expensive to get wrong: when one
 * source stops wanting somebody in a group, whether anybody leaves depends
 * entirely on the OTHER source. Get it wrong in the lenient direction and a
 * revoked grant leaves access in place; get it wrong in the strict direction
 * and an expiring rule ejects somebody a manager deliberately put there.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTION,
  decideSource,
  decideGroup,
  endEmployment,
  removalWanted,
} = require("./telegram_membership_reconcile");
const {
  CLAIM_SOURCE,
  CLAIM_STATE,
  INTENT_REASON,
  CLOSE_OUTCOME,
} = require("../constants/telegram_membership_claim");

const claim = (source, state, over = {}) => ({
  source,
  state,
  telegram_group_id: 10,
  employee_id: 42,
  ...over,
});

describe("one source, wanted", () => {
  it("opens a claim that does not exist", () => {
    const decision = decideSource({ source: CLAIM_SOURCE.RULE, desired: true, claim: null });
    assert.equal(decision.action, ACTION.OPEN);
  });

  it("does nothing when the claim is already ACTIVE", () => {
    const decision = decideSource({
      source: CLAIM_SOURCE.RULE,
      desired: true,
      claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.ACTIVE),
    });
    assert.equal(decision, null);
  });

  it("reopens a CLOSED claim rather than asking for a second row", () => {
    const decision = decideSource({
      source: CLAIM_SOURCE.RULE,
      desired: true,
      claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.CLOSED),
    });
    assert.equal(decision.action, ACTION.OPEN);
  });

  it("CANCELS a removal when eligibility returns before cleanup ran", () => {
    // The change undid itself. Nobody is kicked and then re-invited.
    const decision = decideSource({
      source: CLAIM_SOURCE.RULE,
      desired: true,
      claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.REMOVAL_PENDING),
    });
    assert.equal(decision.action, ACTION.CANCEL_REMOVAL);
  });
});

describe("one source, no longer wanted", () => {
  it("asks for removal when no other source holds them", () => {
    const decision = decideSource({
      source: CLAIM_SOURCE.RULE,
      desired: false,
      claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.ACTIVE),
      partner: null,
      reason: INTENT_REASON.RULE_NO_LONGER_MATCHES,
    });
    assert.equal(decision.action, ACTION.REQUEST_REMOVAL);
    assert.equal(decision.intent_reason, INTENT_REASON.RULE_NO_LONGER_MATCHES);
  });

  it("CLOSES AT ONCE, removing nobody, when the other source is ACTIVE", () => {
    // The rule expiring must not eject somebody a human put there by hand.
    const decision = decideSource({
      source: CLAIM_SOURCE.RULE,
      desired: false,
      claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.ACTIVE),
      partner: claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.ACTIVE),
    });
    assert.equal(decision.action, ACTION.CLOSE_RETAINED);
    assert.equal(decision.close_outcome, CLOSE_OUTCOME.RETAINED_BY_OTHER_SOURCE);
    assert.equal(decision.intent_reason, INTENT_REASON.RETAINED_BY_OTHER_SOURCE);
  });

  it("a partner that is ITSELF on its way out does not retain anybody", () => {
    // REMOVAL_PENDING is not "wants them here". Treating it as a retainer
    // would leave somebody in a group both sources have finished with.
    const decision = decideSource({
      source: CLAIM_SOURCE.RULE,
      desired: false,
      claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.ACTIVE),
      partner: claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.REMOVAL_PENDING),
    });
    assert.equal(decision.action, ACTION.REQUEST_REMOVAL);
  });

  it("does not ask twice", () => {
    const decision = decideSource({
      source: CLAIM_SOURCE.RULE,
      desired: false,
      claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.REMOVAL_PENDING),
      partner: null,
    });
    assert.equal(decision, null);
  });

  it("does nothing at all for a claim that was never live", () => {
    assert.equal(
      decideSource({ source: CLAIM_SOURCE.RULE, desired: false, claim: null }),
      null
    );
    assert.equal(
      decideSource({
        source: CLAIM_SOURCE.RULE,
        desired: false,
        claim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.CLOSED),
      }),
      null
    );
  });
});

describe("one group, both sources", () => {
  it("RECONCILIATION NEVER OPENS OR CLOSES A MANUAL CLAIM on a rule change", () => {
    // A transfer is not a person. Only a human revokes a manual grant.
    const decisions = decideGroup({
      ruleClaim: null,
      manualClaim: claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.ACTIVE),
      ruleDesired: false,
    });
    assert.deepEqual(decisions, []);
  });

  it("a returning rule cancels a MANUAL removal that had not run yet", () => {
    const decisions = decideGroup({
      ruleClaim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.REMOVAL_PENDING),
      manualClaim: claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.REMOVAL_PENDING),
      ruleDesired: true,
    });
    assert.deepEqual(
      decisions.map((d) => [d.source, d.action]).sort(),
      [
        [CLAIM_SOURCE.MANUAL, ACTION.CANCEL_REMOVAL],
        [CLAIM_SOURCE.RULE, ACTION.CANCEL_REMOVAL],
      ].sort()
    );
  });
});

describe("employment ending", () => {
  it("ends EVERY live source, MANUAL included", () => {
    const decisions = endEmployment([
      claim(CLAIM_SOURCE.RULE, CLAIM_STATE.ACTIVE),
      claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.ACTIVE, { telegram_group_id: 11 }),
      claim(CLAIM_SOURCE.RULE, CLAIM_STATE.CLOSED, { telegram_group_id: 12 }),
    ]);
    assert.equal(decisions.length, 2);
    for (const decision of decisions) {
      assert.equal(decision.action, ACTION.REQUEST_REMOVAL);
      assert.equal(decision.intent_reason, INTENT_REASON.EMPLOYMENT_ENDED);
    }
    assert.ok(decisions.some((d) => d.source === CLAIM_SOURCE.MANUAL));
  });

  it("no source retains anybody, because every source is ending", () => {
    const decisions = endEmployment([
      claim(CLAIM_SOURCE.RULE, CLAIM_STATE.ACTIVE),
      claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.ACTIVE),
    ]);
    assert.equal(decisions.length, 2);
  });

  it("does not re-ask for a removal already requested", () => {
    assert.deepEqual(endEmployment([claim(CLAIM_SOURCE.RULE, CLAIM_STATE.REMOVAL_PENDING)]), []);
  });
});

describe("is anybody actually removed", () => {
  it("no, while any source is ACTIVE", () => {
    assert.equal(
      removalWanted({
        ruleClaim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.REMOVAL_PENDING),
        manualClaim: claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.ACTIVE),
      }),
      false
    );
  });

  it("yes, once the last one is REMOVAL_PENDING", () => {
    assert.equal(
      removalWanted({
        ruleClaim: claim(CLAIM_SOURCE.RULE, CLAIM_STATE.REMOVAL_PENDING),
        manualClaim: claim(CLAIM_SOURCE.MANUAL, CLAIM_STATE.CLOSED),
      }),
      true
    );
  });

  it("no, when nothing is live at all", () => {
    assert.equal(removalWanted({ ruleClaim: null, manualClaim: null }), false);
  });
});
