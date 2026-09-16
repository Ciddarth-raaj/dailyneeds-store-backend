/**
 * APPROVING A JOIN REQUEST - the security-critical path. Phase 3B.
 *
 *   node --test usecase/employee_telegram_join_request.test.js
 *
 * THE RULE UNDER TEST: holding our invite link is NOT authorisation to join.
 * An invite link is a URL in a chat message - forwardable, screenshottable,
 * pasteable into a family group. What authorises an approval is that the
 * Telegram account asking IS the account that employee verified with their
 * own phone number. Everything else is how we find the attempt.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const buildHandler = require("./employee_telegram_join_request");
const { ATTEMPT_STATUS, JOIN_REFUSAL, GROUP_READINESS } = require("../constants/telegram_membership");

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

const NOW = new Date("2026-09-16T10:00:00Z");
const CHAT_ID = "-1001234567890";
const INVITE = "https://t.me/+AbCdEfGhIjK";
const EMPLOYEE_TELEGRAM_USER = 555001;
const STRANGER_TELEGRAM_USER = 999999;

const GROUP = {
  telegram_group_id: 10,
  group_name: "ECR Team",
  chat_id: CHAT_ID,
  is_active: true,
};

const liveAttempt = (over = {}) => ({
  employee_telegram_group_join_attempt_id: 77,
  employee_id: 42,
  telegram_group_id: 10,
  status: ATTEMPT_STATUS.PENDING,
  expires_at: new Date(NOW.getTime() + 10 * 60 * 1000),
  ...over,
});

/** A whole world, with every knob the tests need to turn. */
const build = (over = {}) => {
  const calls = { approved: [], declined: [], advanced: [], verified: [] };
  const state = {
    group: GROUP,
    readiness: { status: GROUP_READINESS.READY, reason: null },
    identityByTelegramUser: {
      [EMPLOYEE_TELEGRAM_USER]: { employee_id: 42, employee_telegram_id: 900 },
    },
    attempt: liveAttempt(),
    required: true,
    approveThrows: null,
    memberAfter: { status: "member" },
    ...over,
  };

  const usecase = buildHandler({
    registryRepo: {
      getByChatId: async (chatId) =>
        state.group && String(state.group.chat_id) === String(chatId) ? state.group : null,
      getById: async () => state.group,
    },
    identityRepo: {
      getActiveIdentityByTelegramUser: async (id) => state.identityByTelegramUser[id] || null,
    },
    joinRepo: {
      findAttemptByInviteHash: async () => state.attempt,
      findLiveAttempt: async () => state.attempt,
      advanceStatus: async (id, from, to, opts) => {
        calls.advanced.push({ id, from, to, opts });
        // Model the conditional UPDATE: it only matches from the expected
        // status, which is what makes duplicate delivery a no-op.
        if (state.attempt && state.attempt.status === from) {
          state.attempt = { ...state.attempt, status: to };
          return { changed: true };
        }
        return { changed: false };
      },
    },
    membership: { isGroupRequired: async () => state.required },
    verificationRepo: {
      record: async (row) => {
        calls.verified.push(row);
        return { recorded: true };
      },
    },
    readiness: { check: async () => state.readiness },
    mappingRepo: { getEmployeeForMatching: async () => ({ employee_id: 42, store_id: 5 }) },
    telegram: {
      approveChatJoinRequest: async (chatId, userId) => {
        if (state.approveThrows) throw state.approveThrows;
        calls.approved.push({ chatId, userId });
        return true;
      },
      declineChatJoinRequest: async (chatId, userId) => {
        calls.declined.push({ chatId, userId });
        return true;
      },
      getChatMember: async () => state.memberAfter,
    },
    now: () => NOW,
  });

  return { usecase, calls, state };
};

const update = (over = {}) => ({
  updateId: 1,
  chatJoinRequest: {
    chat: { id: CHAT_ID, type: "supergroup" },
    from: { id: EMPLOYEE_TELEGRAM_USER },
    inviteLink: { inviteLink: INVITE },
    ...over,
  },
});

/* ============================================================== the claim */

describe("the dispatcher claim", () => {
  it("claims every chat_join_request, in either spelling", () => {
    const { usecase } = build();
    assert.equal(usecase.claims(update()), true);
    assert.equal(usecase.claims({ chat_join_request: { chat: {} } }), true);
  });

  it("claims nothing else", () => {
    const { usecase } = build();
    assert.equal(usecase.claims({ message: { text: "/start abc" } }), false);
    assert.equal(usecase.claims({}), false);
    assert.equal(usecase.claims(null), false);
  });

  it("is synchronous, so the claim survives a handler that throws", () => {
    const { usecase } = build();
    assert.equal(typeof usecase.claims(update()), "boolean");
  });
});

/* ========================================================== the happy path */

describe("a valid request", () => {
  it("is approved, and membership is then VERIFIED rather than assumed", async () => {
    const { usecase, calls, state } = build();
    const result = await usecase.handle(update());

    assert.equal(result.approved, true);
    assert.equal(result.joined, true);
    assert.deepEqual(calls.approved, [{ chatId: CHAT_ID, userId: EMPLOYEE_TELEGRAM_USER }]);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
  });

  it("stops at APPROVED when the verification call fails - it claims no membership it has not seen", async () => {
    const { usecase, state } = build();
    state.memberAfter = null;
    const result = await usecase.handle(update());
    assert.equal(result.approved, true);
    assert.equal(result.joined, false);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.APPROVED);
  });

  it("matches the attempt by the invite link's HASH, never a stored URL", async () => {
    const seen = [];
    const { usecase } = build();
    usecase.joinRepo.findAttemptByInviteHash = async (groupId, hash) => {
      seen.push({ groupId, hash });
      return liveAttempt();
    };
    await usecase.handle(update());
    assert.equal(seen[0].hash, sha256(INVITE));
    assert.notEqual(seen[0].hash, INVITE);
    assert.equal(seen[0].groupId, 10, "the group is bound into the match");
  });

  it("falls back to the employee's live attempt when Telegram sends no invite link", async () => {
    // `invite_link` is optional on chat_join_request. The fallback matches on
    // the employee the VERIFIED identity resolves to - the same fact the
    // approval turns on, not a weaker one.
    const { usecase, calls } = build();
    const result = await usecase.handle(update({ inviteLink: undefined }));
    assert.equal(result.approved, true);
    assert.equal(calls.approved.length, 1);
  });
});

/* ====================================================== the forwarded link */

describe("A FORWARDED LINK LETS NOBODY IN", () => {
  it("refuses a stranger holding a real, live, correctly-matched link", async () => {
    // Everything is genuine except who is asking. This is the whole file.
    const { usecase, calls, state } = build();
    const result = await usecase.handle(update({ from: { id: STRANGER_TELEGRAM_USER } }));

    assert.equal(result.approved, false);
    assert.equal(result.reason, JOIN_REFUSAL.IDENTITY_DISCONNECTED);
    assert.deepEqual(calls.approved, [], "nobody was let in");
    assert.equal(state.attempt.status, ATTEMPT_STATUS.PENDING, "the employee's own attempt survives");
  });

  it("refuses another EMPLOYEE holding somebody else's link", async () => {
    // A connected Telegram account, just not the one this attempt was for.
    const { usecase, calls } = build({
      identityByTelegramUser: {
        [STRANGER_TELEGRAM_USER]: { employee_id: 77, employee_telegram_id: 901 },
      },
    });
    const result = await usecase.handle(update({ from: { id: STRANGER_TELEGRAM_USER } }));

    assert.equal(result.approved, false);
    assert.equal(result.reason, JOIN_REFUSAL.IDENTITY_MISMATCH);
    assert.deepEqual(calls.approved, []);
  });

  it("DECLINES NOBODY - a refused request is left for a human", async () => {
    // Declining acts against a real person on the strength of a rule that
    // might be misconfigured. Phase 3B does not act against anybody.
    const { usecase, calls } = build();
    await usecase.handle(update({ from: { id: STRANGER_TELEGRAM_USER } }));
    assert.deepEqual(calls.declined, []);
  });
});

/* =============================================== the other six checks */

describe("the request must survive every check", () => {
  it("refuses a chat that is not a registered group", async () => {
    const { usecase, calls } = build({ group: null });
    const result = await usecase.handle(update());
    assert.equal(result.reason, JOIN_REFUSAL.UNREGISTERED_GROUP);
    assert.deepEqual(calls.approved, []);
  });

  it("refuses when the group is no longer ready, re-checked NOW", async () => {
    // Fifteen minutes is long enough for an admin to be demoted.
    for (const status of [
      GROUP_READINESS.BOT_NOT_ADMIN,
      GROUP_READINESS.BOT_PERMISSION_MISSING,
      GROUP_READINESS.INACTIVE_GROUP,
      GROUP_READINESS.BASIC_GROUP_UNSUPPORTED,
      GROUP_READINESS.TELEGRAM_UNAVAILABLE,
    ]) {
      const { usecase, calls } = build({ readiness: { status, reason: "x" } });
      const result = await usecase.handle(update());
      assert.equal(result.reason, JOIN_REFUSAL.GROUP_NOT_READY, status);
      assert.deepEqual(calls.approved, []);
    }
  });

  it("refuses when there is no attempt at all", async () => {
    const { usecase, calls } = build({ attempt: null });
    const result = await usecase.handle(update());
    assert.equal(result.reason, JOIN_REFUSAL.NO_MATCHING_ATTEMPT);
    assert.deepEqual(calls.approved, []);
  });

  it("refuses an EXPIRED attempt, and concludes it", async () => {
    const { usecase, calls, state } = build({
      attempt: liveAttempt({ expires_at: new Date(NOW.getTime() - 1000) }),
    });
    const result = await usecase.handle(update());
    assert.equal(result.reason, JOIN_REFUSAL.ATTEMPT_EXPIRED);
    assert.deepEqual(calls.approved, []);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.EXPIRED, "not left looking live");
  });

  it("refuses a SUPERSEDED attempt - an older link stops working", async () => {
    const { usecase, calls } = build({
      attempt: liveAttempt({ status: ATTEMPT_STATUS.SUPERSEDED }),
    });
    const result = await usecase.handle(update());
    assert.equal(result.reason, JOIN_REFUSAL.ATTEMPT_NOT_LIVE);
    assert.deepEqual(calls.approved, []);
  });

  it("refuses an attempt that already concluded as JOINED or FAILED", async () => {
    for (const status of [ATTEMPT_STATUS.JOINED, ATTEMPT_STATUS.FAILED, ATTEMPT_STATUS.APPROVED]) {
      const { usecase, calls } = build({ attempt: liveAttempt({ status }) });
      const result = await usecase.handle(update());
      assert.equal(result.reason, JOIN_REFUSAL.ATTEMPT_NOT_LIVE, status);
      assert.deepEqual(calls.approved, []);
    }
  });

  it("refuses when the employee DISCONNECTED after the link was issued", async () => {
    const { usecase, calls } = build({ identityByTelegramUser: {} });
    const result = await usecase.handle(update());
    assert.equal(result.reason, JOIN_REFUSAL.IDENTITY_DISCONNECTED);
    assert.deepEqual(calls.approved, []);
  });

  it("refuses when the group is NO LONGER REQUIRED by current mappings", async () => {
    // A mapping deleted in the fifteen minutes since the link was issued.
    // Joining now would create exactly the stale membership Phase 3C exists
    // to clean up.
    const { usecase, calls } = build({ required: false });
    const result = await usecase.handle(update());
    assert.equal(result.reason, JOIN_REFUSAL.GROUP_NO_LONGER_REQUIRED);
    assert.deepEqual(calls.approved, []);
  });

  it("refuses a malformed payload without throwing", async () => {
    const { usecase, calls } = build();
    for (const bad of [
      { chatJoinRequest: {} },
      { chatJoinRequest: { chat: { id: CHAT_ID } } },
      { chatJoinRequest: { from: { id: 1 } } },
      {},
    ]) {
      const result = await usecase.handle(bad);
      assert.equal(result.approved, false);
    }
    assert.deepEqual(calls.approved, []);
  });
});

/* ============================================== duplicates and failures */

describe("duplicate delivery and retries", () => {
  it("approves ONCE when Telegram delivers the same request twice", async () => {
    // SEQUENTIAL redelivery: by the time the second arrives the attempt has
    // concluded, so it is refused at the still-live check. What matters is
    // the count, not which check caught it.
    const { usecase, calls } = build();
    const first = await usecase.handle(update());
    const second = await usecase.handle(update());

    assert.equal(first.approved, true);
    assert.equal(second.approved, false);
    assert.equal(second.reason, JOIN_REFUSAL.ATTEMPT_NOT_LIVE);
    assert.equal(calls.approved.length, 1, "approved exactly once");
  });

  it("approves ONCE when two deliveries RACE past the live check together", async () => {
    // The concurrent case the conditional UPDATE exists for: both readings
    // saw PENDING, so only the claim can separate them. The loser reports
    // `duplicate` and calls Telegram not at all.
    const { usecase, calls, state } = build();
    let claimed = false;
    usecase.joinRepo.advanceStatus = async (id, from, to) => {
      if (from === ATTEMPT_STATUS.PENDING && to === ATTEMPT_STATUS.JOIN_REQUEST_RECEIVED) {
        if (claimed) return { changed: false };
        claimed = true;
        return { changed: true };
      }
      return { changed: true };
    };
    // Both see a live PENDING attempt, as two concurrent deliveries would.
    state.attempt = liveAttempt();

    const [a, b] = await Promise.all([usecase.handle(update()), usecase.handle(update())]);
    const outcomes = [a, b];
    assert.equal(outcomes.filter((r) => r.approved).length, 1, "exactly one approval");
    const loser = outcomes.find((r) => !r.approved);
    assert.equal(loser.duplicate, true);
    assert.equal(calls.approved.length, 1);
  });

  it("already a participant: CONFIRMS membership before caching it", async () => {
    // Telegram's refusal is an error string from a write we did not
    // complete - not a membership check. The attempt is finished either
    // way, but the cache only learns what getChatMember actually said.
    const err = new Error("Bad Request: USER_ALREADY_PARTICIPANT");
    err.telegramDescription = "Bad Request: USER_ALREADY_PARTICIPANT";
    const { usecase, calls, state } = build({ approveThrows: err });
    state.memberAfter = { status: "member" };

    const result = await usecase.handle(update());

    assert.equal(result.approved, true);
    assert.equal(result.alreadyMember, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
    assert.equal(calls.verified.length, 1);
    assert.equal(calls.verified[0].membership, "JOINED");
    assert.equal(calls.verified[0].employeeTelegramId, 900);
    assert.equal(calls.verified[0].telegramGroupId, 10);
  });

  it("already a participant: caches NOTHING when membership cannot be confirmed", async () => {
    // The attempt still concludes as JOINED - the person is in the group and
    // there is nothing left to approve - but the dashboard reports
    // VERIFICATION_PENDING until somebody looks. Fail closed on the cache,
    // not on the join.
    const err = new Error("Bad Request: USER_ALREADY_PARTICIPANT");
    err.telegramDescription = "Bad Request: USER_ALREADY_PARTICIPANT";

    for (const memberAfter of [null, { status: "left" }, { status: "kicked" }]) {
      const { usecase, calls, state } = build({ approveThrows: err });
      state.memberAfter = memberAfter;
      const result = await usecase.handle(update());

      assert.equal(result.approved, true, JSON.stringify(memberAfter));
      assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
      assert.deepEqual(calls.verified, [], JSON.stringify(memberAfter));
    }
  });

  it("already a participant: a THROWN membership lookup caches nothing and still succeeds", async () => {
    const err = new Error("Bad Request: USER_ALREADY_PARTICIPANT");
    err.telegramDescription = "Bad Request: USER_ALREADY_PARTICIPANT";
    const { usecase, calls, state } = build({ approveThrows: err });
    usecase.telegram.getChatMember = async () => {
      throw new Error("ETIMEDOUT");
    };

    const result = await usecase.handle(update());
    assert.equal(result.approved, true);
    assert.equal(result.alreadyMember, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
    assert.deepEqual(calls.verified, []);
  });

  it("already a participant: a CACHE failure does not undo the success", async () => {
    const err = new Error("Bad Request: USER_ALREADY_PARTICIPANT");
    err.telegramDescription = "Bad Request: USER_ALREADY_PARTICIPANT";
    const { usecase, state } = build({ approveThrows: err });
    state.memberAfter = { status: "member" };
    usecase.verificationRepo.record = async () => {
      throw new Error("cache table is gone");
    };

    const result = await usecase.handle(update());
    assert.equal(result.approved, true);
    assert.equal(result.alreadyMember, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
  });

  it("already a participant: works with no verification repository wired", async () => {
    const err = new Error("Bad Request: USER_ALREADY_PARTICIPANT");
    err.telegramDescription = "Bad Request: USER_ALREADY_PARTICIPANT";
    const { usecase, state } = build({ approveThrows: err });
    usecase.verificationRepo = null;
    const result = await usecase.handle(update());
    assert.equal(result.approved, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
  });

  it("treats USER_ALREADY_PARTICIPANT as a success, not a failure", async () => {
    // Somebody let them in by hand, or a retry raced us. They are in the
    // group, which is the outcome we wanted.
    const err = new Error("Bad Request: USER_ALREADY_PARTICIPANT");
    err.telegramDescription = "Bad Request: USER_ALREADY_PARTICIPANT";
    const { usecase, state } = build({ approveThrows: err });
    const result = await usecase.handle(update());

    assert.equal(result.approved, true);
    assert.equal(result.alreadyMember, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
  });

  /* ------------------------------------------- HIDE_REQUESTER_MISSING ----- */

  const hideRequesterError = () => {
    const err = new Error("Bad Request: HIDE_REQUESTER_MISSING");
    err.telegramDescription = "Bad Request: HIDE_REQUESTER_MISSING";
    return err;
  };

  it("hide requester missing: a CONFIRMED member is JOINED and cached", async () => {
    // The request is gone from Telegram's side because they are already in.
    // That is the one reading of this error we may act on, and only because
    // getChatMember said so.
    const { usecase, calls, state } = build({ approveThrows: hideRequesterError() });
    state.memberAfter = { status: "member" };

    const result = await usecase.handle(update());

    assert.equal(result.approved, true);
    assert.equal(result.alreadyMember, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
    assert.equal(calls.verified.length, 1);
    assert.equal(calls.verified[0].membership, "JOINED");
    assert.equal(calls.verified[0].employeeTelegramId, 900);
    assert.equal(calls.verified[0].telegramGroupId, 10);
  });

  it("hide requester missing: a CONFIRMED non-member is NOT joined", async () => {
    // The request vanished for one of its other reasons - cancelled,
    // declined, aged out - and nobody joined anything. Calling this JOINED
    // would put a membership in the record that Telegram just denied.
    for (const memberAfter of [{ status: "left" }, { status: "kicked" }, null]) {
      const { usecase, calls, state } = build({ approveThrows: hideRequesterError() });
      state.memberAfter = memberAfter;

      const result = await usecase.handle(update());

      const where = JSON.stringify(memberAfter);
      assert.equal(result.approved, false, where);
      assert.equal(result.reason, JOIN_REFUSAL.APPROVAL_FAILED, where);
      assert.equal(state.attempt.status, ATTEMPT_STATUS.FAILED, where);
      assert.notEqual(state.attempt.status, ATTEMPT_STATUS.JOINED, where);
      assert.deepEqual(calls.verified, [], where);
    }
  });

  it("hide requester missing: an UNANSWERABLE lookup claims no membership", async () => {
    // We could not ask, so we know nothing. The attempt stays exactly where
    // it is - received, not concluded - for somebody to review.
    const { usecase, calls, state } = build({ approveThrows: hideRequesterError() });
    usecase.telegram.getChatMember = async () => {
      throw new Error("ETIMEDOUT");
    };

    const result = await usecase.handle(update());

    assert.equal(result.approved, false);
    assert.equal(result.reason, JOIN_REFUSAL.APPROVAL_FAILED);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOIN_REQUEST_RECEIVED);
    assert.notEqual(state.attempt.status, ATTEMPT_STATUS.JOINED);
    assert.notEqual(state.attempt.status, ATTEMPT_STATUS.FAILED);
    assert.deepEqual(calls.verified, []);
  });

  it("hide requester missing: the error ALONE never proves membership", async () => {
    // The distinction under test: USER_ALREADY_PARTICIPANT concludes the
    // attempt as JOINED on its own, HIDE_REQUESTER_MISSING never does. Same
    // world, same non-member, two different outcomes.
    const alreadyErr = new Error("Bad Request: USER_ALREADY_PARTICIPANT");
    alreadyErr.telegramDescription = "Bad Request: USER_ALREADY_PARTICIPANT";

    const already = build({ approveThrows: alreadyErr });
    already.state.memberAfter = { status: "left" };
    const hidden = build({ approveThrows: hideRequesterError() });
    hidden.state.memberAfter = { status: "left" };

    await already.usecase.handle(update());
    await hidden.usecase.handle(update());

    assert.equal(already.state.attempt.status, ATTEMPT_STATUS.JOINED);
    assert.equal(hidden.state.attempt.status, ATTEMPT_STATUS.FAILED);
  });

  it("hide requester missing: a CACHE failure does not change the outcome", async () => {
    const { usecase, state } = build({ approveThrows: hideRequesterError() });
    state.memberAfter = { status: "member" };
    usecase.verificationRepo.record = async () => {
      throw new Error("cache table is gone");
    };

    const result = await usecase.handle(update());

    assert.equal(result.approved, true);
    assert.equal(result.alreadyMember, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
  });

  it("hide requester missing: a confirmed member joins with no verification repository", async () => {
    const { usecase, state } = build({ approveThrows: hideRequesterError() });
    usecase.verificationRepo = null;
    state.memberAfter = { status: "member" };

    const result = await usecase.handle(update());

    assert.equal(result.approved, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
  });

  it("marks the attempt FAILED on a genuine approval error, and approves nobody", async () => {
    const err = new Error("Bad Request: CHAT_ADMIN_REQUIRED");
    err.telegramDescription = "Bad Request: CHAT_ADMIN_REQUIRED";
    const { usecase, state } = build({ approveThrows: err });
    const result = await usecase.handle(update());

    assert.equal(result.approved, false);
    assert.equal(result.reason, JOIN_REFUSAL.APPROVAL_FAILED);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.FAILED);
  });

  it("claims the attempt BEFORE calling Telegram, never after", async () => {
    const order = [];
    const { usecase } = build();
    const realAdvance = usecase.joinRepo.advanceStatus;
    usecase.joinRepo.advanceStatus = async (...args) => {
      order.push(`advance:${args[2]}`);
      return realAdvance(...args);
    };
    usecase.telegram.approveChatJoinRequest = async () => {
      order.push("approve");
      return true;
    };
    await usecase.handle(update());
    assert.equal(order[0], `advance:${ATTEMPT_STATUS.JOIN_REQUEST_RECEIVED}`);
    assert.equal(order[1], "approve", "a crash between the two must not leave a re-approvable row");
  });
});

/* ================================================== the dashboard's cache */

describe("a confirmed join teaches the dashboard immediately", () => {
  it("records a JOINED verification against the identity row", async () => {
    // The join completes asynchronously, with nobody looking at a screen.
    // Without this the employee sits in the queue as VERIFICATION_PENDING
    // after the join that finished them.
    const { usecase, calls } = build();
    const result = await usecase.handle(update());

    assert.equal(result.joined, true);
    assert.equal(calls.verified.length, 1);
    assert.equal(calls.verified[0].employeeTelegramId, 900);
    assert.equal(calls.verified[0].employeeId, 42);
    assert.equal(calls.verified[0].telegramGroupId, 10);
    assert.equal(calls.verified[0].membership, "JOINED");
    assert.equal(calls.verified[0].readinessStatus, GROUP_READINESS.READY);
  });

  it("writes NOTHING when post-approval verification could not be made", async () => {
    // Approved, but Telegram would not confirm. The attempt stays APPROVED
    // and the cache learns nothing - a membership we have not seen is not a
    // membership, here as everywhere else.
    const { usecase, calls, state } = build();
    state.memberAfter = null;
    const result = await usecase.handle(update());

    assert.equal(result.approved, true);
    assert.equal(result.joined, false);
    assert.deepEqual(calls.verified, []);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.APPROVED);
  });

  it("writes NOTHING when the verification call throws", async () => {
    const { usecase, calls } = build();
    usecase.telegram.getChatMember = async () => {
      throw new Error("ETIMEDOUT");
    };
    const result = await usecase.handle(update());
    assert.equal(result.approved, true);
    assert.deepEqual(calls.verified, []);
  });

  it("writes NOTHING on any refused request", async () => {
    for (const over of [
      { required: false },
      { attempt: null },
      { identityByTelegramUser: {} },
      { readiness: { status: GROUP_READINESS.BOT_NOT_ADMIN, reason: "x" } },
    ]) {
      const { usecase, calls } = build(over);
      await usecase.handle(update());
      assert.deepEqual(calls.verified, [], JSON.stringify(over));
    }
  });

  it("a cache failure never undoes an approval that already happened", async () => {
    const { usecase, calls, state } = build();
    usecase.verificationRepo.record = async () => {
      throw new Error("cache table is gone");
    };
    const result = await usecase.handle(update());
    assert.equal(result.approved, true);
    assert.equal(result.joined, true);
    assert.equal(state.attempt.status, ATTEMPT_STATUS.JOINED);
    assert.equal(calls.approved.length, 1);
  });

  it("works unchanged with no verification repository wired", async () => {
    const { usecase } = build();
    usecase.verificationRepo = null;
    const result = await usecase.handle(update());
    assert.equal(result.approved, true);
    assert.equal(result.joined, true);
  });

  it("caches no Telegram identifier", async () => {
    const { usecase, calls } = build();
    await usecase.handle(update());
    const body = JSON.stringify(calls.verified[0]);
    assert.ok(!body.includes(String(EMPLOYEE_TELEGRAM_USER)));
    assert.ok(!body.includes(CHAT_ID));
    assert.ok(!body.includes(INVITE));
  });
});

/* ================================================================ privacy */

describe("what a refusal may say", () => {
  it("never sends the requester a message", async () => {
    const sent = [];
    const { usecase } = build();
    usecase.telegram.sendMessage = async (...a) => sent.push(a);
    await usecase.handle(update({ from: { id: STRANGER_TELEGRAM_USER } }));
    assert.deepEqual(sent, [], "telling a stranger whose link they hold is a disclosure");
  });

  it("returns a reason code and no personal detail", async () => {
    const { usecase } = build({ identityByTelegramUser: {} });
    const result = await usecase.handle(update());
    const body = JSON.stringify(result);
    assert.ok(!body.includes(String(EMPLOYEE_TELEGRAM_USER)));
    assert.ok(!body.includes(INVITE));
    assert.ok(!body.includes(CHAT_ID));
  });
});

/* =============================================================== boundary */

describe("PHASE 3B REMOVES NOBODY", () => {
  it("never calls a removal method, on any path", async () => {
    const forbidden = [];
    const cases = [
      {},
      { required: false },
      { attempt: null },
      { identityByTelegramUser: {} },
      { readiness: { status: GROUP_READINESS.BOT_NOT_ADMIN, reason: "x" } },
      { attempt: liveAttempt({ expires_at: new Date(NOW.getTime() - 1) }) },
    ];
    for (const over of cases) {
      const { usecase } = build(over);
      for (const method of ["banChatMember", "unbanChatMember", "kickChatMember", "restrictChatMember"]) {
        usecase.telegram[method] = async () => forbidden.push(method);
      }
      await usecase.handle(update());
      await usecase.handle(update({ from: { id: STRANGER_TELEGRAM_USER } }));
    }
    assert.deepEqual(forbidden, [], "no path in this phase removes anybody");
  });
});
