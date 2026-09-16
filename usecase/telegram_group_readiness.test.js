/**
 * Readiness fetching: what it asks Telegram, and what it does when it cannot.
 *
 *   node --test usecase/telegram_group_readiness.test.js
 *
 * The decision itself is `utils/telegram_membership.js#groupReadiness` and is
 * tested there. This covers the fetching: the call budget, the bot-id cache,
 * and that a failure is reported as "we could not ask" rather than as a
 * verdict about somebody's group.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildReadiness = require("./telegram_group_readiness");
const { GROUP_READINESS } = require("../constants/telegram_membership");

const GROUP = { telegram_group_id: 1, chat_id: "-1001", is_active: true, bot_is_admin: true };

const telegram = (over = {}) => {
  const calls = { getMe: 0, getChat: [], getChatMember: [] };
  const state = {
    me: { id: 7000 },
    chat: { type: "supergroup" },
    botMember: { status: "administrator", canInviteUsers: true },
    configured: true,
    throws: null,
    ...over,
  };
  return {
    calls,
    state,
    isConfigured: () => state.configured,
    getMe: async () => {
      calls.getMe += 1;
      if (state.throws) throw state.throws;
      return state.me;
    },
    getChat: async (id) => {
      calls.getChat.push(id);
      if (state.throws) throw state.throws;
      return state.chat;
    },
    getChatMember: async (chatId, userId) => {
      calls.getChatMember.push({ chatId, userId });
      if (state.throws) throw state.throws;
      return state.botMember;
    },
  };
};

describe("what it asks Telegram", () => {
  it("asks who the bot is, then the chat, then the bot's standing in it", async () => {
    const t = telegram();
    const result = await buildReadiness(t).check(GROUP);
    assert.equal(result.status, GROUP_READINESS.READY);
    assert.deepEqual(t.calls.getChat, ["-1001"]);
    assert.deepEqual(t.calls.getChatMember, [{ chatId: "-1001", userId: 7000 }]);
  });

  it("caches the bot id - it cannot change for a token", async () => {
    const t = telegram();
    const readiness = buildReadiness(t);
    await readiness.check(GROUP);
    await readiness.check({ ...GROUP, telegram_group_id: 2, chat_id: "-1002" });
    assert.equal(t.calls.getMe, 1, "asking per group would triple the call count for free");
  });

  it("does NOT ask about membership when the chat is not a supergroup", async () => {
    // A Basic Group cannot be managed whatever the bot's standing.
    const t = telegram({ chat: { type: "group" } });
    const result = await buildReadiness(t).check(GROUP);
    assert.equal(result.status, GROUP_READINESS.BASIC_GROUP_UNSUPPORTED);
    assert.deepEqual(t.calls.getChatMember, [], "a call that could not change the answer");
  });

  it("asks Telegram NOTHING about a retired registry group", async () => {
    const t = telegram();
    const result = await buildReadiness(t).check({ ...GROUP, is_active: false });
    assert.equal(result.status, GROUP_READINESS.INACTIVE_GROUP);
    assert.equal(t.calls.getMe, 0);
    assert.deepEqual(t.calls.getChat, []);
  });

  it("asks nothing when Telegram is not configured", async () => {
    const t = telegram({ configured: false });
    const result = await buildReadiness(t).check(GROUP);
    assert.equal(result.status, GROUP_READINESS.TELEGRAM_UNAVAILABLE);
    assert.deepEqual(t.calls.getChat, []);
  });

  it("is two calls per group - never one per employee", async () => {
    const t = telegram();
    const readiness = buildReadiness(t);
    const groups = [1, 2, 3].map((id) => ({ ...GROUP, telegram_group_id: id, chat_id: `-100${id}` }));
    await readiness.checkMany(groups);
    assert.equal(t.calls.getChat.length, 3);
    assert.equal(t.calls.getChatMember.length, 3);
    assert.equal(t.calls.getMe, 1);
  });
});

describe("when Telegram cannot be reached", () => {
  it("reports TELEGRAM_UNAVAILABLE rather than a verdict about the group", async () => {
    // Nothing is known to be wrong with it. Reporting a fault would send
    // somebody to fix a group that is fine.
    const t = telegram({ throws: new Error("ETIMEDOUT") });
    const result = await buildReadiness(t).check(GROUP);
    assert.equal(result.status, GROUP_READINESS.TELEGRAM_UNAVAILABLE);
    assert.match(result.reason, /temporarily unavailable/);
  });

  it("NEVER throws - readiness is one column on a screen with other things to show", async () => {
    const t = telegram({ throws: new Error("boom") });
    await assert.doesNotReject(() => buildReadiness(t).check(GROUP));
    await assert.doesNotReject(() => buildReadiness(t).checkMany([GROUP]));
  });

  it("does not mistake an unreachable Telegram for a demoted bot", async () => {
    const t = telegram({ throws: new Error("ECONNRESET") });
    const result = await buildReadiness(t).check(GROUP);
    assert.notEqual(result.status, GROUP_READINESS.BOT_NOT_ADMIN);
    assert.notEqual(result.status, GROUP_READINESS.BOT_NOT_MEMBER);
  });
});

describe("the registry checkbox is never the answer", () => {
  it("a group whose bot_is_admin says true is still refused when Telegram disagrees", async () => {
    const t = telegram({ botMember: { status: "member" } });
    const result = await buildReadiness(t).check({ ...GROUP, bot_is_admin: true });
    assert.equal(result.status, GROUP_READINESS.BOT_NOT_ADMIN);
  });

  it("a group whose bot_is_admin says false is READY when Telegram agrees it is", async () => {
    const t = telegram();
    const result = await buildReadiness(t).check({ ...GROUP, bot_is_admin: false });
    assert.equal(result.status, GROUP_READINESS.READY);
  });
});
