/**
 * REMOVAL READINESS - a different question from Phase 3B's, and a test that
 * says so. Phase 3C.
 *
 *   node --test utils/telegram_removal_readiness.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  REMOVAL_READINESS,
  removalReadiness,
  canRemove,
} = require("./telegram_removal_readiness");
const { groupReadiness } = require("./telegram_membership");
const { GROUP_READINESS } = require("../constants/telegram_membership");

const chat = (type = "supergroup") => ({ type });

describe("what makes a removal possible", () => {
  it("an administrator WITH can_restrict_members", () => {
    const answer = removalReadiness({
      chat: chat(),
      botMember: { status: "administrator", canRestrictMembers: true },
    });
    assert.equal(answer.status, REMOVAL_READINESS.READY);
    assert.ok(canRemove(answer));
  });

  it("reads the snake_case flag too, because `_callBotApi` does not camelCase", () => {
    assert.equal(
      removalReadiness({
        chat: chat(),
        botMember: { status: "administrator", can_restrict_members: true },
      }).status,
      REMOVAL_READINESS.READY
    );
  });

  it("THE CREATOR IS ALLOWED WITHOUT THE FLAG, which Telegram may omit", () => {
    assert.equal(
      removalReadiness({ chat: chat(), botMember: { status: "creator" } }).status,
      REMOVAL_READINESS.READY
    );
  });

  it("an administrator without the right cannot remove", () => {
    assert.equal(
      removalReadiness({ chat: chat(), botMember: { status: "administrator" } }).status,
      REMOVAL_READINESS.BOT_CANNOT_RESTRICT
    );
  });

  it("a plain member is not an admin", () => {
    assert.equal(
      removalReadiness({ chat: chat(), botMember: { status: "member" } }).status,
      REMOVAL_READINESS.BOT_NOT_ADMIN
    );
  });

  it("left or kicked is not a member", () => {
    for (const status of ["left", "kicked"]) {
      assert.equal(
        removalReadiness({ chat: chat(), botMember: { status } }).status,
        REMOVAL_READINESS.BOT_NOT_MEMBER
      );
    }
  });

  it("a Basic Group has no reliable member administration", () => {
    assert.equal(
      removalReadiness({ chat: chat("group"), botMember: { status: "creator" } }).status,
      REMOVAL_READINESS.NOT_SUPERGROUP
    );
  });

  it("a missing answer is UNAVAILABLE, never a configuration fault", () => {
    // "We could not ask" must not be reported as "somebody set this up wrong".
    assert.equal(
      removalReadiness({ chat: null, botMember: null }).status,
      REMOVAL_READINESS.TELEGRAM_UNAVAILABLE
    );
    assert.equal(
      removalReadiness({ chat: chat(), botMember: null }).status,
      REMOVAL_READINESS.TELEGRAM_UNAVAILABLE
    );
    assert.ok(!canRemove(removalReadiness({ chat: null, botMember: null })));
  });
});

describe("it is NOT Phase 3B's readiness", () => {
  it("the two disagree exactly where they should", () => {
    // Invite rights and removal rights are different rights, and a bot can
    // hold either without the other.
    const canInviteOnly = { status: "administrator", canInviteUsers: true };
    const canRestrictOnly = { status: "administrator", canRestrictMembers: true };

    const ACTIVE_GROUP = { telegram_group_id: 10, is_active: true };
    assert.equal(
      groupReadiness(ACTIVE_GROUP, { chat: chat(), botMember: canInviteOnly }).status,
      GROUP_READINESS.READY
    );
    assert.equal(
      removalReadiness({ chat: chat(), botMember: canInviteOnly }).status,
      REMOVAL_READINESS.BOT_CANNOT_RESTRICT
    );

    assert.equal(
      groupReadiness(ACTIVE_GROUP, { chat: chat(), botMember: canRestrictOnly }).status,
      GROUP_READINESS.BOT_PERMISSION_MISSING
    );

    // AND THE ONE THAT MATTERS MOST: a RETIRED group refuses joins and still
    // permits cleanup. Without this, switching a group off would strand
    // everybody inside it.
    const RETIRED = { telegram_group_id: 10, is_active: false };
    assert.equal(
      groupReadiness(RETIRED, { chat: chat(), botMember: canRestrictOnly }).status,
      GROUP_READINESS.INACTIVE_GROUP
    );
    assert.equal(
      removalReadiness({ chat: chat(), botMember: canRestrictOnly }).status,
      REMOVAL_READINESS.READY
    );
    assert.equal(
      removalReadiness({ chat: chat(), botMember: canRestrictOnly }).status,
      REMOVAL_READINESS.READY
    );
  });

  it("PHASE 3B's FUNCTION IS NOT MODIFIED BY PHASE 3C", () => {
    // The file is read, not the behaviour guessed at: `groupReadiness` must
    // still ask for `can_invite_users` and must not have learned about
    // restriction rights on the way past.
    const source = fs.readFileSync(path.join(__dirname, "telegram_membership.js"), "utf8");
    assert.match(source, /can_invite_users/);
    assert.ok(!/can_restrict_members|canRestrictMembers/.test(source));
    assert.ok(!/REMOVAL_READINESS/.test(source));
  });

  it("registry is_active is NOT part of removal readiness", () => {
    // A retired group must still be cleanable - that is exactly when
    // cleanup matters. `is_active` is not even an input here.
    const source = fs.readFileSync(
      path.join(__dirname, "telegram_removal_readiness.js"),
      "utf8"
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.ok(!/is_active/.test(code));
  });
});
