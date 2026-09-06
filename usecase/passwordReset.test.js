const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const buildPasswordReset = require("./passwordReset");
const { parseStartPayload } = require("./passwordReset");

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

/** A user repository holding one account, recording password writes. */
const makeUserRepo = () => {
  const calls = { updated: [] };
  return {
    calls,
    // Stage 0A: the repository already excludes system / employee-less
    // rows; the fake returns the shape the guarded query returns.
    getByUsername: async (username) =>
      username === "raj"
        ? { user_id: 7, username: "raj", employee_id: 1007, is_system_account: 0, status: 1, employee_status: 1, employee_name: "Raj", primary_contact_number: "9000000007" }
        : null,
    // Stage 0A: the only password writer. Records the hash it was given.
    setModernPassword: async (userId, passwordHash, opts) => {
      calls.updated.push({ userId, passwordHash, opts });
    },
  };
};

/**
 * An in-memory stand-in for the reset repository.
 *
 * `link` and `active` are set by each test to describe the starting state;
 * everything else records what the usecase did to it.
 */
const makeResetRepo = ({ link = null, active = null, recentCount = 0 } = {}) => {
  const calls = { created: [], attempts: [], consumed: [], saved: [], deleted: [] };
  return {
    calls,
    state: { link, active },
    getLinkByUserId: async () => link,
    saveLink: async (userId, chatId, username) => {
      calls.saved.push({ userId, chatId, username });
    },
    deleteLink: async (userId) => calls.deleted.push(userId),
    createLinkToken: async () => {},
    consumeLinkToken: async (hash) => (hash === sha256("good-token") ? 7 : null),
    createResetCode: async (userId, codeHash, expiresAt) => {
      calls.created.push({ userId, codeHash, expiresAt });
    },
    getActiveResetCode: async () => active,
    countRecentResetCodes: async () => recentCount,
    recordResetAttempt: async (id) => calls.attempts.push(id),
    consumeResetCode: async (id) => {
      calls.consumed.push(id);
      return true;
    },
  };
};

/** A Telegram service that records sends instead of making them. */
const makeTelegram = ({ botUsername = "dnds_bot", failSend = false } = {}) => {
  const sent = [];
  return {
    sent,
    getBotUsername: async () => botUsername,
    getUpdates: async () => [],
    sendMessage: async (chatId, msg) => {
      if (failSend) throw new Error("telegram down");
      sent.push({ chatId, msg });
      return { code: 200 };
    },
  };
};

describe("parseStartPayload", () => {
  it("reads the token out of a /start message", () => {
    assert.equal(parseStartPayload("/start abc123"), "abc123");
    assert.equal(parseStartPayload("  /start abc123  "), "abc123");
    assert.equal(parseStartPayload("/start@dnds_bot abc123"), "abc123");
  });

  it("ignores anything that is not a /start carrying a token", () => {
    assert.equal(parseStartPayload("/start"), null);
    assert.equal(parseStartPayload("hello"), null);
    assert.equal(parseStartPayload(undefined), null);
  });
});

describe("startLink", () => {
  it("builds a deep link at the configured bot", async () => {
    const usecase = buildPasswordReset(makeUserRepo(), makeResetRepo(), makeTelegram());
    const result = await usecase.startLink(7);

    assert.equal(result.code, 200);
    assert.match(result.link, /^https:\/\/t\.me\/dnds_bot\?start=[0-9a-f]{48}$/);
  });

  // Guessing at the bot name would send staff to a stranger's bot, which is
  // worse than saying the feature is not set up.
  it("refuses when the bot cannot be reached", async () => {
    const usecase = buildPasswordReset(
      makeUserRepo(),
      makeResetRepo(),
      makeTelegram({ botUsername: "" })
    );
    await assert.rejects(() => usecase.startLink(7), (err) => err.name === "ValidationError");
  });
});

describe("completeLink", () => {
  it("attaches the chat that presented a valid token", async () => {
    const repo = makeResetRepo();
    const telegram = makeTelegram();
    const usecase = buildPasswordReset(makeUserRepo(), repo, telegram);

    const linked = await usecase.completeLink(
      "good-token",
      { id: 4242 },
      { username: "raj_t" }
    );

    assert.equal(linked, true);
    assert.deepEqual(repo.calls.saved, [{ userId: 7, chatId: 4242, username: "raj_t" }]);
    assert.match(telegram.sent[0].msg, /Linked/);
  });

  it("tells the user when the link has expired instead of failing silently", async () => {
    const repo = makeResetRepo();
    const telegram = makeTelegram();
    const usecase = buildPasswordReset(makeUserRepo(), repo, telegram);

    const linked = await usecase.completeLink("stale", { id: 4242 }, {});

    assert.equal(linked, false);
    assert.deepEqual(repo.calls.saved, []);
    assert.match(telegram.sent[0].msg, /expired/);
  });
});

describe("requestReset", () => {
  it("sends a six-digit code to the linked chat", async () => {
    const repo = makeResetRepo({ link: { chat_id: 4242 } });
    const telegram = makeTelegram();
    const usecase = buildPasswordReset(makeUserRepo(), repo, telegram);

    const result = await usecase.requestReset("raj");

    assert.equal(result.code, 200);
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].chatId, 4242);
    const code = telegram.sent[0].msg.match(/\*(\d{6})\*/)[1];
    // Only the hash is stored, so the code cannot be read back out of the row.
    assert.equal(repo.calls.created[0].codeHash, sha256(code));
  });

  // The three cases below must be indistinguishable from outside, or the
  // screen becomes a way to find out who works here and who has Telegram.
  const neutral = async (repo, telegram, username) => {
    const usecase = buildPasswordReset(makeUserRepo(), repo, telegram);
    return usecase.requestReset(username);
  };

  it("answers the same for an unknown username", async () => {
    const telegram = makeTelegram();
    const result = await neutral(makeResetRepo(), telegram, "nobody");
    assert.equal(result.code, 200);
    assert.equal(telegram.sent.length, 0);
  });

  it("answers the same for an account with no Telegram linked", async () => {
    const telegram = makeTelegram();
    const result = await neutral(makeResetRepo({ link: null }), telegram, "raj");
    assert.equal(result.code, 200);
    assert.equal(telegram.sent.length, 0);
  });

  it("answers the same when Telegram delivery fails", async () => {
    const telegram = makeTelegram({ failSend: true });
    const result = await neutral(makeResetRepo({ link: { chat_id: 1 } }), telegram, "raj");
    assert.equal(result.code, 200);
  });

  it("stops sending once the hourly cap is reached", async () => {
    const repo = makeResetRepo({ link: { chat_id: 4242 }, recentCount: 5 });
    const telegram = makeTelegram();
    const result = await neutral(repo, telegram, "raj");

    assert.equal(result.code, 200);
    assert.equal(telegram.sent.length, 0);
    assert.deepEqual(repo.calls.created, []);
  });
});

describe("resetPassword", () => {
  const activeFor = (code, attempts = 0) => ({
    id: 11,
    user_id: 7,
    code_hash: sha256(code),
    attempts,
  });

  it("sets the new password for the right code", async () => {
    const userRepo = makeUserRepo();
    const repo = makeResetRepo({ active: activeFor("123456") });
    const usecase = buildPasswordReset(userRepo, repo, makeTelegram());

    const result = await usecase.resetPassword("raj", "123456", "new-secret");

    assert.equal(result.code, 200);
    // Stage 0A: a modern hash is stored, never the plaintext and never SHA-1.
    assert.equal(userRepo.calls.updated.length, 1);
    assert.equal(userRepo.calls.updated[0].userId, 7);
    assert.match(userRepo.calls.updated[0].passwordHash, /^\$scrypt\$/);
    assert.deepEqual(userRepo.calls.updated[0].opts, { clearMustChange: true });
    // Spent, so the same code cannot be replayed.
    assert.deepEqual(repo.calls.consumed, [11]);
  });

  it("counts a wrong code as an attempt and changes nothing", async () => {
    const userRepo = makeUserRepo();
    const repo = makeResetRepo({ active: activeFor("123456") });
    const usecase = buildPasswordReset(userRepo, repo, makeTelegram());

    const result = await usecase.resetPassword("raj", "999999", "new-secret");

    assert.equal(result.error, "INVALID_CODE");
    assert.deepEqual(userRepo.calls.updated, []);
    assert.deepEqual(repo.calls.attempts, [11]);
  });

  it("burns the code after too many wrong guesses", async () => {
    const userRepo = makeUserRepo();
    const repo = makeResetRepo({ active: activeFor("123456", 5) });
    const usecase = buildPasswordReset(userRepo, repo, makeTelegram());

    const result = await usecase.resetPassword("raj", "123456", "new-secret");

    assert.equal(result.error, "TOO_MANY_ATTEMPTS");
    assert.deepEqual(userRepo.calls.updated, []);
    assert.deepEqual(repo.calls.consumed, [11]);
  });

  it("says nothing different for an unknown username than a wrong code", async () => {
    const usecase = buildPasswordReset(makeUserRepo(), makeResetRepo(), makeTelegram());
    const unknown = await usecase.resetPassword("nobody", "123456", "new-secret");
    const noCode = await usecase.resetPassword("raj", "123456", "new-secret");

    assert.deepEqual(unknown, noCode);
  });

  it("refuses a new password shorter than the minimum, without spending the code", async () => {
    const repo = makeResetRepo({ active: activeFor("123456") });
    const usecase = buildPasswordReset(makeUserRepo(), repo, makeTelegram());
    const result = await usecase.resetPassword("raj", "123456", "short");
    // Stage 0A: a policy failure is an answer the employee can act on, and
    // the code stays valid for the retry.
    assert.equal(result.error, "PASSWORD_POLICY");
    assert.match(result.msg, /at least 8 characters/);
    assert.match(result.msg, /code is still valid/);
    assert.deepEqual(repo.calls.consumed, []);
  });
});

describe("pollTelegramUpdates", () => {
  it("links from a /start message and acknowledges the update", async () => {
    const repo = makeResetRepo();
    const telegram = makeTelegram();
    telegram.getUpdates = async () => [
      {
        updateId: 900,
        message: { chat: { id: 4242 }, from: { username: "raj_t" }, text: "/start good-token" },
      },
    ];
    const usecase = buildPasswordReset(makeUserRepo(), repo, telegram);

    const result = await usecase.pollTelegramUpdates();

    assert.equal(result.linked, 1);
    assert.equal(usecase.updateOffset, 901);
  });

  it("skips chatter that is not a /start token", async () => {
    const repo = makeResetRepo();
    const telegram = makeTelegram();
    telegram.getUpdates = async () => [
      { updateId: 5, message: { chat: { id: 1 }, text: "good morning" } },
    ];
    const usecase = buildPasswordReset(makeUserRepo(), repo, telegram);

    const result = await usecase.pollTelegramUpdates();

    assert.equal(result.linked, 0);
    assert.deepEqual(repo.calls.saved, []);
    assert.equal(usecase.updateOffset, 6);
  });

  // A webhook registered on the bot makes getUpdates fail with 409; the tick
  // must survive it rather than take the cron down.
  it("survives a getUpdates failure", async () => {
    const telegram = makeTelegram();
    telegram.getUpdates = async () => {
      throw new Error("409 Conflict");
    };
    const usecase = buildPasswordReset(makeUserRepo(), makeResetRepo(), telegram);

    const result = await usecase.pollTelegramUpdates();
    assert.equal(result.code, 500);
  });
});
