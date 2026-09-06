/**
 * Telegram password reset on the integrated Stage 0A branch.
 *
 * Covers C1 (modern hash only), C2 (explicit system-account exclusion),
 * C3 (unified policy and the employee-facing rejection), C4 (unconfigured
 * poller is a no-op; re-entrancy), audit events, privilege non-elevation,
 * and the five outstanding-code cases across the Deployment A boundary.
 *
 * The reset repository is the same in-memory shape production uses: the
 * OLD backend and the NEW one read the same `password_reset_codes` rows, so
 * "a code created by the old code" is simply a row with a sha256 hash and
 * an expiry - which is exactly what the old implementation stored.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const buildPasswordReset = require("./passwordReset");
const { isResettableAccount, NEUTRAL_REQUEST_RESULT } = require("./passwordReset");
const passwordService = require("../services/password");
const F = require("../test_support/auth_fixtures");

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const IP = "203.0.113.5";

/** Rows as the guarded getByUsername returns them - system rows are NOT returned by it. */
function makeUserRepo(rows) {
  const repo = F.fakeUserRepo(rows);
  repo.getByUsername = async (username) => {
    const r = Object.values(rows).find((x) => x.username === username);
    if (!r) return null;
    // mirror the SQL predicates exactly
    if (Number(r.status) !== 1) return null;
    if (Number(r.is_system_account) === 1) return null;
    if (r.employee_id === null || r.employee_id === undefined) return null;
    if (Number(r.employee_status) !== 1) return null;
    return { ...r };
  };
  // an unguarded variant, to prove the usecase refuses on its own (C2 test 5)
  repo.getByUsernameUnguarded = async (username) => {
    const r = Object.values(rows).find((x) => x.username === username);
    return r ? { ...r } : null;
  };
  return repo;
}

/** In-memory password_reset_codes / telegram_links, with real expiry semantics. */
function makeResetRepo({ links = {}, codes = [] } = {}, nowFn = () => new Date()) {
  let nextId = codes.length + 1;
  return {
    codes,
    links,
    async getLinkByUserId(userId) { return links[userId] || null; },
    async saveLink(userId, chatId, username) { links[userId] = { user_id: userId, chat_id: chatId, telegram_username: username }; },
    async deleteLink(userId) { delete links[userId]; },
    async createLinkToken() {},
    async consumeLinkToken(hash) { return hash === sha256("good-token") ? 7 : null; },
    async createResetCode(userId, codeHash, expiresAt) {
      for (const c of codes) if (c.user_id === userId && !c.consumed_at) c.consumed_at = nowFn();
      codes.push({ id: nextId++, user_id: userId, code_hash: codeHash, expires_at: expiresAt, consumed_at: null, attempts: 0, created_at: nowFn() });
    },
    async getActiveResetCode(userId) {
      const live = codes.filter((c) => c.user_id === userId && !c.consumed_at && c.expires_at > nowFn());
      return live.length ? live[live.length - 1] : null;
    },
    async countRecentResetCodes(userId, since) { return codes.filter((c) => c.user_id === userId && c.created_at > since).length; },
    async recordResetAttempt(id) { codes.find((c) => c.id === id).attempts += 1; },
    async consumeResetCode(id) {
      const c = codes.find((x) => x.id === id);
      if (!c || c.consumed_at) return false;
      c.consumed_at = nowFn();
      return true;
    },
  };
}

function makeTelegram({ configured = true } = {}) {
  const sent = [];
  return {
    sent,
    updatesCalls: 0,
    isConfigured: () => configured,
    getBotUsername: async () => (configured ? "dnds_bot" : ""),
    async getUpdates() { this.updatesCalls += 1; return []; },
    async sendMessage(chatId, msg) { sent.push({ chatId, msg }); return { code: 200 }; },
  };
}

const EMP = { user_id: 7, username: "rajkumar_k", employee_id: 1007, primary_contact_number: "9000000007" };

const directory = async () => ({
  raj: F.employeeRow({ ...EMP, password: F.legacyHash("old-sha1-pass"), password_algo: "sha1" }),
  admin: F.employeeRow({ user_id: 8, username: "admin", employee_id: 1008, user_type: 2, password: F.legacyHash("admin-pass-1") }),
  breakglass: F.systemRow({ user_id: 99, username: "breakglass", password_hash: await F.hashCheap("a-very-long-break-glass-secret-2026") }),
  left: F.employeeRow({ user_id: 12, username: "left", employee_id: 1012, employee_status: 0, password: F.legacyHash("p1234567") }),
});

/** An OLD-backend code: sha256 of a six-digit string, ten-minute expiry, as production wrote it. */
const oldCode = (userId, code, { minutesLeft = 5, consumed = false, attempts = 0 } = {}, now = Date.now()) => ({
  id: Math.floor(Math.random() * 1e6),
  user_id: userId,
  code_hash: sha256(code),
  expires_at: new Date(now + minutesLeft * 60 * 1000),
  consumed_at: consumed ? new Date(now - 60000) : null,
  attempts,
  created_at: new Date(now - 60000),
});

function build(rows, { links, codes, telegram, now } = {}) {
  const userRepo = makeUserRepo(rows);
  const nowFn = now || (() => new Date());
  const resetRepo = makeResetRepo({ links: links || {}, codes: codes || [] }, nowFn);
  const authLog = F.fakeAuthLog();
  const tg = telegram || makeTelegram();
  const usecase = buildPasswordReset(userRepo, resetRepo, tg, { authLogRepo: authLog, passwords: { ...passwordService, hash: F.hashCheap }, now: nowFn });
  return { usecase, userRepo, resetRepo, authLog, telegram: tg };
}

const linkFor = (userId, chatId = 555) => ({ [userId]: { user_id: userId, chat_id: chatId, telegram_username: "raj_tg" } });

describe("C2 — explicit system-account exclusion", () => {
  it("1. a normal employee can use the reset flow end to end", async () => {
    const rows = await directory();
    const { usecase, telegram, authLog } = build(rows, { links: linkFor(7) });
    assert.deepEqual(await usecase.requestReset("rajkumar_k", { ip: IP }), NEUTRAL_REQUEST_RESULT);
    const code = telegram.sent[0].msg.match(/\*(\d{6})\*/)[1];
    const r = await usecase.resetPassword("rajkumar_k", code, "blue-kettle-42", { ip: IP });
    assert.equal(r.code, 200);
    assert.equal(rows.raj.password_algo, "scrypt");
    assert.ok(authLog.events.some((e) => e.event === "reset_requested" && e.detail === "telegram;sent"));
    assert.ok(authLog.events.some((e) => e.event === "reset_completed" && e.detail === "telegram"));
  });

  it("2. the break-glass username cannot request a reset, and gets the neutral answer", async () => {
    const rows = await directory();
    const { usecase, telegram, resetRepo, authLog } = build(rows, { links: linkFor(99) });
    const r = await usecase.requestReset("breakglass", { ip: IP });
    assert.deepEqual(r, NEUTRAL_REQUEST_RESULT, "same answer as an unknown user");
    assert.equal(telegram.sent.length, 0);
    assert.equal(resetRepo.codes.length, 0, "3. no code is generated for it");
    assert.ok(authLog.events.some((e) => e.event === "reset_requested" && /unknown_user|refused_protected/.test(e.detail)));
  });

  it("4. a normal admin cannot use the reset flow to change break-glass credentials even with a planted code", async () => {
    const rows = await directory();
    const planted = oldCode(99, "123456");
    const before = JSON.stringify(rows.breakglass);
    const { usecase, resetRepo } = build(rows, { links: linkFor(99), codes: [planted] });
    const r = await usecase.resetPassword("breakglass", "123456", "another-very-long-secret-xyz", { ip: IP });
    assert.equal(r.error, "INVALID_CODE");
    assert.equal(JSON.stringify(rows.breakglass), before);
    assert.equal(resetRepo.codes[0].consumed_at, null, "the planted code is not even consulted");
  });

  it("5. the usecase refuses a system row on its own even if the repository stops filtering", async () => {
    const rows = await directory();
    const { usecase, userRepo, telegram } = build(rows, { links: linkFor(99), codes: [oldCode(99, "123456")] });
    userRepo.getByUsername = userRepo.getByUsernameUnguarded; // simulate a future join change
    assert.deepEqual(await usecase.requestReset("breakglass", { ip: IP }), NEUTRAL_REQUEST_RESULT);
    assert.equal(telegram.sent.length, 0);
    assert.equal((await usecase.resetPassword("breakglass", "123456", "another-very-long-secret-xyz")).error, "INVALID_CODE");
    // employee-less non-system row
    rows.orphan = F.employeeRow({ user_id: 5, username: "orphan", employee_id: null });
    assert.deepEqual(await usecase.requestReset("orphan", { ip: IP }), NEUTRAL_REQUEST_RESULT);
    assert.equal(telegram.sent.length, 0);
  });

  it("isResettableAccount is explicit: system, employee_id NULL, disabled and inactive employee all refuse", () => {
    assert.equal(isResettableAccount(null), false);
    assert.equal(isResettableAccount({ user_id: 1, employee_id: 5, is_system_account: 1, status: 1 }), false);
    assert.equal(isResettableAccount({ user_id: 1, employee_id: null, is_system_account: 0, status: 1 }), false);
    assert.equal(isResettableAccount({ user_id: 1, employee_id: 5, is_system_account: 0, status: 0 }), false);
    assert.equal(isResettableAccount({ user_id: 1, employee_id: 5, is_system_account: 0, status: 1, employee_status: 0 }), false);
    assert.equal(isResettableAccount({ user_id: 1, employee_id: 5, is_system_account: 0, status: 1, employee_status: 1 }), true);
  });

  it("an inactive employee cannot reset either", async () => {
    const rows = await directory();
    const { usecase, telegram } = build(rows, { links: linkFor(12) });
    assert.deepEqual(await usecase.requestReset("left", { ip: IP }), NEUTRAL_REQUEST_RESULT);
    assert.equal(telegram.sent.length, 0);
  });
});

describe("C1 — modern hash only", () => {
  it("a reset writes scrypt via setModernPassword; the legacy column is cleared; SHA-1 is never produced", async () => {
    const rows = await directory();
    const { usecase, userRepo } = build(rows, { links: linkFor(7), codes: [oldCode(7, "654321")] });
    const r = await usecase.resetPassword("rajkumar_k", "654321", "blue-kettle-42", { ip: IP });
    assert.equal(r.code, 200);
    assert.ok(userRepo.calls.some((c) => c[0] === "setModernPassword" && c[1] === 7));
    assert.equal(rows.raj.password_algo, "scrypt");
    assert.equal(rows.raj.password, null);
    assert.ok(rows.raj.password_hash.startsWith("$scrypt$"));
    assert.notEqual(rows.raj.password_hash, F.legacyHash("blue-kettle-42"));
    assert.ok(rows.raj.password_migrated_at === undefined || rows.raj.password_migrated_at !== null);
    assert.ok(rows.raj.token_valid_from instanceof Date, "old sessions are cut off");
  });

  it("the usecase has no path to a legacy password writer", () => {
    const src = require("fs").readFileSync(require.resolve("./passwordReset"), "utf8");
    assert.doesNotMatch(src, /updatePassword\(/);
    assert.doesNotMatch(src, /SHA1/);
  });

  it("no plaintext password or code reaches the audit log", async () => {
    const rows = await directory();
    const { usecase, telegram, authLog } = build(rows, { links: linkFor(7) });
    await usecase.requestReset("rajkumar_k", { ip: IP });
    const code = telegram.sent[0].msg.match(/\*(\d{6})\*/)[1];
    await usecase.resetPassword("rajkumar_k", code, "blue-kettle-42", { ip: IP });
    const dumped = JSON.stringify(authLog.events);
    assert.equal(dumped.includes("blue-kettle-42"), false);
    assert.equal(dumped.includes(code), false);
  });
});

describe("C3 — unified policy and the employee-facing rejection", () => {
  const cases = [
    ["short1", /at least 8 characters/],
    // identity-equality cases must clear the length floor first, so the
    // employee's 8+ character identities are used (the fixture username is
    // "rajkumar_k", mobile "9000000007"); the four-digit employee code alone
    // is already caught by the length rule, which is the point of a single
    // ordered policy.
    ["rajkumar_k", /username|employee code|mobile/],
    ["RAJKUMAR_K", /username|employee code|mobile/],
    ["9000000007", /mobile/],
    ["1007@123", /known default/],
    ["password123", /too common/],
  ];
  for (const [pw, re] of cases) {
    it(`rejects ${JSON.stringify(pw)} with an actionable message and keeps the code valid`, async () => {
      const rows = await directory();
      const { usecase, resetRepo } = build(rows, { links: linkFor(7), codes: [oldCode(7, "654321")] });
      const r = await usecase.resetPassword("rajkumar_k", "654321", pw, { ip: IP });
      assert.equal(r.code, 400);
      assert.equal(r.error, "PASSWORD_POLICY");
      assert.match(r.msg, re);
      assert.match(r.msg, /code is still valid/);
      assert.equal(resetRepo.codes[0].consumed_at, null, "code not spent");
      assert.equal(rows.raj.password_algo, "sha1", "nothing written");
      // and the retry with the same code succeeds
      const ok = await usecase.resetPassword("rajkumar_k", "654321", "blue-kettle-42", { ip: IP });
      assert.equal(ok.code, 200);
    });
  }

  it("the same policy function is used as change-password and setup (one rule set)", async () => {
    const policy = require("../utils/password_policy");
    const ctx = { username: "rajkumar_k", employeeId: 1007, mobile: "9000000007" };
    assert.equal(policy.check("1007@123", ctx).ok, false);
    assert.equal(policy.check("blue-kettle-42", ctx).ok, true);
    const src = require("fs").readFileSync(require.resolve("./passwordReset"), "utf8");
    assert.match(src, /require\("\.\.\/utils\/password_policy"\)/);
    assert.doesNotMatch(src, /MIN_PASSWORD_LENGTH = 6/);
  });
});

describe("Outstanding reset codes across the Deployment A boundary", () => {
  it("1. a code created by the OLD backend is redeemed by the NEW backend and writes scrypt", async () => {
    const rows = await directory();
    const { usecase } = build(rows, { links: linkFor(7), codes: [oldCode(7, "111111")] });
    const r = await usecase.resetPassword("rajkumar_k", "111111", "blue-kettle-42", { ip: IP });
    assert.equal(r.code, 200);
    assert.equal(rows.raj.password_algo, "scrypt");
  });

  it("2. a code created shortly before deployment keeps its original expiry - no extension", async () => {
    const rows = await directory();
    const base = Date.now();
    const code = oldCode(7, "222222", { minutesLeft: 2 }, base);
    let t = base;
    const { usecase } = build(rows, { links: linkFor(7), codes: [code], now: () => new Date(t) });
    t = base + 3 * 60 * 1000; // three minutes after deployment
    const r = await usecase.resetPassword("rajkumar_k", "222222", "blue-kettle-42", { ip: IP });
    assert.equal(r.error, "INVALID_CODE", "safely rejected as expired");
    assert.equal(rows.raj.password_algo, "sha1");
  });

  it("3. an old code with a password that now fails policy: clear message, code kept, retry works", async () => {
    const rows = await directory();
    const { usecase, resetRepo } = build(rows, { links: linkFor(7), codes: [oldCode(7, "333333")] });
    const r = await usecase.resetPassword("rajkumar_k", "333333", "abc123", { ip: IP }); // 6 chars: fine before, refused now
    assert.equal(r.error, "PASSWORD_POLICY");
    assert.match(r.msg, /at least 8 characters/);
    assert.equal(resetRepo.codes[0].consumed_at, null);
    assert.equal((await usecase.resetPassword("rajkumar_k", "333333", "blue-kettle-42", { ip: IP })).code, 200);
  });

  it("4. a code already consumed before deployment is rejected and cannot be revived", async () => {
    const rows = await directory();
    const { usecase } = build(rows, { links: linkFor(7), codes: [oldCode(7, "444444", { consumed: true })] });
    assert.equal((await usecase.resetPassword("rajkumar_k", "444444", "blue-kettle-42", { ip: IP })).error, "INVALID_CODE");
    assert.equal(rows.raj.password_algo, "sha1");
  });

  it("5. the same code submitted twice across the boundary: first wins, second is rejected", async () => {
    const rows = await directory();
    const { usecase } = build(rows, { links: linkFor(7), codes: [oldCode(7, "555555")] });
    assert.equal((await usecase.resetPassword("rajkumar_k", "555555", "blue-kettle-42", { ip: IP })).code, 200);
    const again = await usecase.resetPassword("rajkumar_k", "555555", "green-lamp-77", { ip: IP });
    assert.equal(again.error, "INVALID_CODE");
    assert.equal(await passwordService.verifyModern(rows.raj.password_hash, "blue-kettle-42"), true, "first password stands");
  });

  it("an old code cannot invoke SHA-1 or bypass policy under any of the above", async () => {
    const rows = await directory();
    const { usecase } = build(rows, { links: linkFor(7), codes: [oldCode(7, "666666")] });
    await usecase.resetPassword("rajkumar_k", "666666", "rajkumar_k", { ip: IP }); // policy refuses
    assert.equal(rows.raj.password_algo, "sha1");
    await usecase.resetPassword("rajkumar_k", "666666", "blue-kettle-42", { ip: IP });
    assert.equal(rows.raj.password_algo, "scrypt");
    assert.notEqual(rows.raj.password_hash, F.legacyHash("blue-kettle-42"));
  });
});

describe("Reset cannot elevate or manufacture", () => {
  it("a reset changes the password and nothing else: user_type, employee_id, is_system_account untouched", async () => {
    const rows = await directory();
    const { usecase } = build(rows, { links: linkFor(7), codes: [oldCode(7, "777777")] });
    await usecase.resetPassword("rajkumar_k", "777777", "blue-kettle-42", { ip: IP });
    assert.equal(rows.raj.user_type, 1);
    assert.equal(rows.raj.employee_id, 1007);
    assert.equal(rows.raj.is_system_account, 0);
    assert.equal(Object.values(rows).filter((r) => r.is_system_account).length, 1);
  });
});

describe("C4 — poller", () => {
  it("is a no-op when Telegram is not configured, and never throws", async () => {
    const rows = await directory();
    const tg = makeTelegram({ configured: false });
    const { usecase } = build(rows, { telegram: tg });
    const r = await usecase.pollTelegramUpdates();
    assert.equal(r.skipped, "not_configured");
    assert.equal(tg.updatesCalls, 0);
  });

  it("does not overlap itself: a slow poll makes the next tick skip", async () => {
    const rows = await directory();
    let release;
    const tg = makeTelegram();
    tg.getUpdates = () => new Promise((res) => { release = () => res([]); });
    const { usecase } = build(rows, { telegram: tg });
    const first = usecase.pollTelegramUpdates();
    const second = await usecase.pollTelegramUpdates();
    assert.equal(second.skipped, "in_progress");
    release();
    assert.equal((await first).code, 200);
  });

  it("advances the offset past every update it saw, so a restart resumes rather than replays", async () => {
    const rows = await directory();
    const tg = makeTelegram();
    tg.getUpdates = async () => [{ updateId: 40, message: { text: "hello", chat: { id: 1 } } }, { updateId: 41, message: { text: "/start good-token", chat: { id: 555 }, from: { username: "raj_tg" } } }];
    const { usecase, resetRepo } = build(rows, { telegram: tg });
    const r = await usecase.pollTelegramUpdates();
    assert.equal(r.linked, 1);
    assert.equal(usecase.updateOffset, 42);
    assert.ok(resetRepo.links[7]);
  });

  it("survives a getUpdates failure and reports it", async () => {
    const rows = await directory();
    const tg = makeTelegram();
    tg.getUpdates = async () => { throw new Error("409 webhook active"); };
    const { usecase } = build(rows, { telegram: tg });
    assert.equal((await usecase.pollTelegramUpdates()).code, 500);
  });
});
