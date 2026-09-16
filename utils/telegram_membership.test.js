/**
 * Group readiness, membership and completion - the pure rules. Phase 3B.
 *
 *   node --test utils/telegram_membership.test.js
 *
 * Executed against plain objects shaped like Telegram's own responses, so
 * the rules are tested rather than a mock of the whole world.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  groupReadiness,
  isReady,
  isTelegramMember,
  membershipStatus,
  attemptIsLive,
  telegramComplete,
} = require("./telegram_membership");
const {
  GROUP_READINESS,
  READINESS_REASON,
  MEMBERSHIP_STATUS,
  ATTEMPT_STATUS,
} = require("../constants/telegram_membership");

const ACTIVE = { telegram_group_id: 1, is_active: true, bot_is_admin: true };
const SUPERGROUP = { type: "supergroup" };

describe("group readiness", () => {
  it("an inactive registry group is INACTIVE_GROUP, without asking Telegram", () => {
    const r = groupReadiness({ ...ACTIVE, is_active: false }, {});
    assert.equal(r.status, GROUP_READINESS.INACTIVE_GROUP);
    assert.equal(r.reason, READINESS_REASON.INACTIVE_GROUP);
  });

  it("a Basic Group is unsupported for managed membership", () => {
    const r = groupReadiness(ACTIVE, { chat: { type: "group" } });
    assert.equal(r.status, GROUP_READINESS.BASIC_GROUP_UNSUPPORTED);
    assert.match(r.reason, /Basic Group/);
  });

  it("the bot not being in the group is BOT_NOT_MEMBER", () => {
    for (const status of ["left", "kicked"]) {
      const r = groupReadiness(ACTIVE, { chat: SUPERGROUP, botMember: { status } });
      assert.equal(r.status, GROUP_READINESS.BOT_NOT_MEMBER, status);
    }
  });

  it("the bot being an ordinary member is BOT_NOT_ADMIN", () => {
    const r = groupReadiness(ACTIVE, { chat: SUPERGROUP, botMember: { status: "member" } });
    assert.equal(r.status, GROUP_READINESS.BOT_NOT_ADMIN);
  });

  it("an admin WITHOUT can_invite_users is BOT_PERMISSION_MISSING", () => {
    // The right that matters: without it the failure happens after somebody
    // has already tapped the link.
    const r = groupReadiness(ACTIVE, {
      chat: SUPERGROUP,
      botMember: { status: "administrator", canInviteUsers: false },
    });
    assert.equal(r.status, GROUP_READINESS.BOT_PERMISSION_MISSING);
    assert.match(r.reason, /join requests/);
  });

  it("an admin WITH can_invite_users is READY, in either spelling", () => {
    for (const member of [
      { status: "administrator", canInviteUsers: true },
      { status: "administrator", can_invite_users: true },
    ]) {
      assert.equal(groupReadiness(ACTIVE, { chat: SUPERGROUP, botMember: member }).status, GROUP_READINESS.READY);
    }
  });

  it("the creator is READY even when Telegram omits the flag", () => {
    const r = groupReadiness(ACTIVE, { chat: SUPERGROUP, botMember: { status: "creator" } });
    assert.equal(r.status, GROUP_READINESS.READY);
    assert.equal(r.reason, null);
  });

  it("a Telegram failure is TELEGRAM_UNAVAILABLE, NOT a verdict on the group", () => {
    // Nothing is known to be wrong. Reporting misconfiguration would send
    // somebody to fix a group that is fine.
    for (const telegram of [{ unavailable: true }, {}, { chat: SUPERGROUP, botMember: null }]) {
      const r = groupReadiness(ACTIVE, telegram);
      assert.equal(r.status, GROUP_READINESS.TELEGRAM_UNAVAILABLE);
    }
  });

  it("NEVER consults the registry's bot_is_admin checkbox", () => {
    // Somebody ticked the box and then demoted the bot. Telegram wins.
    const r = groupReadiness(
      { ...ACTIVE, bot_is_admin: true },
      { chat: SUPERGROUP, botMember: { status: "member" } }
    );
    assert.equal(r.status, GROUP_READINESS.BOT_NOT_ADMIN);
  });

  it("checks the registry switch BEFORE Telegram, so a retired group costs no call", () => {
    const r = groupReadiness({ ...ACTIVE, is_active: false }, { unavailable: true });
    assert.equal(r.status, GROUP_READINESS.INACTIVE_GROUP, "our own flag decides first");
  });

  it("isReady is true only for READY", () => {
    assert.equal(isReady({ status: GROUP_READINESS.READY }), true);
    for (const status of Object.values(GROUP_READINESS).filter((s) => s !== "READY")) {
      assert.equal(isReady({ status }), false, status);
    }
    assert.equal(isReady(null), false);
  });
});

describe("is this person in the group", () => {
  it("counts member, administrator AND creator as joined", () => {
    // The creator is in the group more than anybody; asking them to join is
    // absurd, and `status === "member"` alone gets it wrong.
    for (const status of ["member", "administrator", "creator"]) {
      assert.equal(isTelegramMember({ status }), true, status);
    }
  });

  it("reads is_member for restricted, rather than guessing", () => {
    // Telegram uses one status for muted-but-present and restricted-and-gone.
    assert.equal(isTelegramMember({ status: "restricted", isMember: true }), true);
    assert.equal(isTelegramMember({ status: "restricted", is_member: true }), true);
    assert.equal(isTelegramMember({ status: "restricted", isMember: false }), false);
    assert.equal(isTelegramMember({ status: "restricted" }), false);
  });

  it("left and kicked are not members", () => {
    assert.equal(isTelegramMember({ status: "left" }), false);
    assert.equal(isTelegramMember({ status: "kicked" }), false);
  });

  it("an absent or malformed answer is not a membership", () => {
    for (const bad of [null, undefined, {}, { status: "" }]) {
      assert.equal(isTelegramMember(bad), false);
    }
  });
});

describe("what the screen shows", () => {
  const ready = { status: GROUP_READINESS.READY };
  const notReady = { status: GROUP_READINESS.BOT_NOT_ADMIN };

  it("readiness comes first - even ahead of a known membership", () => {
    // A "Joined" we cannot verify would make somebody look complete when
    // nothing about the group can be checked.
    assert.equal(
      membershipStatus({ readiness: notReady, joined: true }),
      MEMBERSHIP_STATUS.GROUP_NOT_READY
    );
  });

  it("joined beats a live attempt", () => {
    assert.equal(
      membershipStatus({ readiness: ready, joined: true, liveAttempt: {} }),
      MEMBERSHIP_STATUS.JOINED
    );
  });

  it("a live attempt reads JOIN_PENDING", () => {
    assert.equal(
      membershipStatus({ readiness: ready, joined: false, liveAttempt: {} }),
      MEMBERSHIP_STATUS.JOIN_PENDING
    );
  });

  it("otherwise there is something to do", () => {
    assert.equal(
      membershipStatus({ readiness: ready, joined: false, liveAttempt: null }),
      MEMBERSHIP_STATUS.ACTION_REQUIRED
    );
  });
});

describe("an attempt is live only while PENDING and unexpired", () => {
  const now = new Date("2026-09-16T10:00:00Z");
  const future = new Date("2026-09-16T10:10:00Z");
  const past = new Date("2026-09-16T09:59:00Z");

  it("PENDING and in the future", () => {
    assert.equal(attemptIsLive({ status: ATTEMPT_STATUS.PENDING, expires_at: future }, now), true);
  });

  it("PENDING but past its expiry is not live", () => {
    assert.equal(attemptIsLive({ status: ATTEMPT_STATUS.PENDING, expires_at: past }, now), false);
  });

  it("no other status is live, however fresh", () => {
    for (const status of Object.values(ATTEMPT_STATUS).filter((s) => s !== "PENDING")) {
      assert.equal(attemptIsLive({ status, expires_at: future }, now), false, status);
    }
  });

  it("a missing or unparseable expiry is not live", () => {
    for (const expires_at of [null, undefined, "not a date"]) {
      assert.equal(attemptIsLive({ status: ATTEMPT_STATUS.PENDING, expires_at }, now), false);
    }
  });
});

describe("Telegram Complete", () => {
  const joined = { membership_status: MEMBERSHIP_STATUS.JOINED };
  const pending = { membership_status: MEMBERSHIP_STATUS.JOIN_PENDING };
  const action = { membership_status: MEMBERSHIP_STATUS.ACTION_REQUIRED };
  const notReady = { membership_status: MEMBERSHIP_STATUS.GROUP_NOT_READY };

  it("connected and every required group joined", () => {
    assert.equal(telegramComplete({ connected: true, groups: [joined, joined] }), true);
  });

  it("connected with ZERO required groups is complete", () => {
    // Nothing left to do. Reporting incomplete for a requirement nobody has
    // placed on them would be a queue item that can never be cleared.
    assert.equal(telegramComplete({ connected: true, groups: [] }), true);
    assert.equal(telegramComplete({ connected: true }), true);
  });

  it("one pending group means NOT complete", () => {
    assert.equal(telegramComplete({ connected: true, groups: [joined, pending] }), false);
  });

  it("one group NOT READY means NOT complete", () => {
    // Not the employee's fault, but the requirement is genuinely unmet and a
    // green tick would hide the group that needs fixing.
    assert.equal(telegramComplete({ connected: true, groups: [joined, notReady] }), false);
  });

  it("one group still to act on means NOT complete", () => {
    assert.equal(telegramComplete({ connected: true, groups: [joined, action] }), false);
  });

  it("a disconnected identity is never complete, whatever the groups say", () => {
    assert.equal(telegramComplete({ connected: false, groups: [joined, joined] }), false);
    assert.equal(telegramComplete({ connected: false, groups: [] }), false);
    assert.equal(telegramComplete({}), false);
  });
});
