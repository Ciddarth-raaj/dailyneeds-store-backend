/**
 * Route-level system-account protection (safety correction pass, item 5;
 * regression category 14E).
 *
 * A real Express app with the REAL auth middleware, the REAL permissions
 * middleware (user_type 2 bypasses every permission check, exactly as in
 * production) and the REAL /user router, authenticated as a normal admin,
 * attempting every mutation that exists - and proving the ones the brief
 * lists that do NOT exist have no route at all.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-jwt-prot-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ legacy: path.join(dir, "pub.key") });
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";
process.env.JWT_TOKEN_CUTOFF = "0";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const F = require("../test_support/auth_fixtures");
const buildUserUsecase = require("../usecase/user");
const buildPasswordReset = require("../usecase/passwordReset");
const passwordService = require("../services/password");
const jwtService = require("../services/jwt");

const SYSTEM_ID = 99;
const ADMIN_ID = 7;
const EMP_ID = 8;

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

/**
 * The guarded `getByUsername` the merged repository/user.js exposes: the SQL
 * predicates (`status = 1`, `is_system_account = 0`, `employee_id IS NOT
 * NULL`, employee active) mirrored on the in-memory rows.
 */
function withGuardedLookup(repo, rows) {
  repo.getByUsername = async (username) => {
    const r = Object.values(rows).find((x) => x.username === username);
    if (!r) return null;
    if (Number(r.status) !== 1) return null;
    if (Number(r.is_system_account) === 1) return null;
    if (r.employee_id === null || r.employee_id === undefined) return null;
    if (Number(r.employee_status) !== 1) return null;
    return { ...r };
  };
  return repo;
}

/** In-memory telegram_links / password_reset_codes. */
function fakeResetRepo() {
  const links = {};
  const codes = [];
  let nextId = 1;
  return {
    links,
    codes,
    async getLinkByUserId(userId) { return links[userId] || null; },
    async saveLink(userId, chatId, username) { links[userId] = { user_id: userId, chat_id: chatId, telegram_username: username }; },
    async deleteLink(userId) { delete links[userId]; },
    async createLinkToken(userId, hash, expiresAt) { this.linkTokens = (this.linkTokens || []).concat([{ userId, hash, expiresAt }]); },
    async consumeLinkToken() { return null; },
    async createResetCode(userId, codeHash, expiresAt) {
      codes.push({ id: nextId++, user_id: userId, code_hash: codeHash, expires_at: expiresAt, consumed_at: null, attempts: 0, created_at: new Date() });
    },
    async getActiveResetCode(userId) {
      const live = codes.filter((c) => c.user_id === userId && !c.consumed_at && c.expires_at > new Date());
      return live.length ? live[live.length - 1] : null;
    },
    async countRecentResetCodes(userId, since) { return codes.filter((c) => c.user_id === userId && c.created_at > since).length; },
    async recordResetAttempt(id) { codes.find((c) => c.id === id).attempts += 1; },
    async consumeResetCode(id) {
      const c = codes.find((x) => x.id === id);
      if (!c || c.consumed_at) return false;
      c.consumed_at = new Date();
      return true;
    },
  };
}

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    isConfigured: () => true,
    getBotUsername: async () => "dnds_test_bot",
    async getUpdates() { return []; },
    async sendMessage(chatId, msg) { sent.push({ chatId, msg }); return { code: 200 }; },
  };
}

let rows, userRepo, app, server, port, adminToken, systemToken, authLog, resetRepo, telegram;

before(async () => {
  rows = {
    admin: F.employeeRow({ user_id: ADMIN_ID, username: "admin", employee_id: 1001, user_type: 2, password: F.legacyHash("admin-pass-1") }),
    emp: F.employeeRow({ user_id: EMP_ID, username: "emp", employee_id: 1002, user_type: 1, password: F.legacyHash("emp-pass-1") }),
    breakglass: F.systemRow({ user_id: SYSTEM_ID, password_hash: await F.hashCheap("a-very-long-break-glass-secret-2026") }),
  };
  userRepo = withGuardedLookup(F.fakeUserRepo(rows), rows);
  authLog = F.fakeAuthLog();
  resetRepo = fakeResetRepo();
  telegram = fakeTelegram();
  const config = F.config();
  const usecase = buildUserUsecase(userRepo, null, null, { authLogRepo: authLog, config });
  const passwordResetUsecase = buildPasswordReset(userRepo, resetRepo, telegram, {
    authLogRepo: authLog,
    passwords: { ...passwordService, hash: F.hashCheap },
  });
  const permissions = require("../middlewares/permissions")({ getPermissionById: async () => [] });
  const authMw = require("../middlewares/auth").create({ userUsecase: usecase, config });
  delete require.cache[require.resolve("./user")];
  const routes = require("./user")(usecase, permissions, { invalidate() {} }, { authLogRepo: authLog, authMiddleware: authMw, config, passwordResetUsecase });

  app = express();
  app.set("trust proxy", "loopback");
  app.use(bodyParser.json());
  app.use(authMw);
  app.use("/user", routes.getRouter());
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", () => { port = server.address().port; r(); }); });

  adminToken = await jwtService.sign({ auth_ver: 2, id: ADMIN_ID, employee_id: 1001, user_type: 2, designation_id: 4, store_id: 2 }, "1h", { subject: String(ADMIN_ID) });
  systemToken = await jwtService.sign({ auth_ver: 2, id: SYSTEM_ID, user_type: 2, sys: true }, "1h", { subject: String(SYSTEM_ID) });
});
after(() => server && server.close());

const call = (method, p, body, token = adminToken) =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "content-type": "application/json", "x-access-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const snapshot = () => JSON.stringify(rows.breakglass);

describe("14E / §5 — a normal admin cannot touch the system account through any API", () => {
  it("cannot reset break-glass credentials", async () => {
    const before = snapshot();
    const res = await call("POST", `/user/${SYSTEM_ID}/reset-password`);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "SYSTEM_ACCOUNT");
    assert.equal(snapshot(), before);
    assert.equal(userRepo.tokens.length, 0, "no reset token was issued");
  });

  it("cannot unlock (modify status) of the system account", async () => {
    const before = snapshot();
    const res = await call("POST", `/user/${SYSTEM_ID}/unlock`);
    assert.equal(res.status, 403);
    assert.equal(snapshot(), before);
  });

  it("cannot change the system account's IP policy (generic user modification)", async () => {
    const before = snapshot();
    const res = await call("POST", "/user/ip-restrictions", { user_id: SYSTEM_ID, allowed_ips: "", ip_policy: "branch" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "SYSTEM_ACCOUNT");
    assert.equal(snapshot(), before);
  });

  it("cannot change the system account's password even when holding its own session", async () => {
    const before = snapshot();
    const res = await call("POST", "/user/change-password", { current_password: "a-very-long-break-glass-secret-2026", new_password: "another-very-long-secret-xyz" }, systemToken);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "SYSTEM_ACCOUNT");
    assert.equal(snapshot(), before);
  });

  it("cannot create a break-glass account: no route accepts is_system_account, and no user-creation route exists", async () => {
    const attempts = [
      ["POST", "/user", { username: "evil", password: "x", is_system_account: 1, user_type: 2 }],
      ["POST", "/user/create", { username: "evil", is_system_account: 1 }],
      ["PUT", "/user/1", { is_system_account: 1 }],
      ["PATCH", "/user/1", { is_system_account: 1 }],
      ["POST", "/user/1", { is_system_account: 1 }],
    ];
    for (const [m, p, b] of attempts) {
      const res = await call(m, p, b);
      assert.ok(res.status === 404 || res.status === 403 || res.status === 405, `${m} ${p} -> ${res.status}`);
    }
    assert.equal(Object.values(rows).filter((r) => r.is_system_account).length, 1);
  });

  it("cannot convert an employee account into a system account, change its username, user_type, employee link, or delete it: no such routes", async () => {
    const attempts = [
      ["PATCH", `/user/${EMP_ID}`, { is_system_account: 1 }],
      ["PUT", `/user/${EMP_ID}`, { username: "renamed" }],
      ["PATCH", `/user/${EMP_ID}`, { user_type: 2 }],
      ["PATCH", `/user/${EMP_ID}`, { employee_id: null }],
      ["POST", `/user/${EMP_ID}/employee`, { employee_id: null }],
      ["POST", `/user/${EMP_ID}/status`, { status: 0 }],
      ["POST", `/user/${EMP_ID}/enable`, {}],
      ["POST", `/user/${EMP_ID}/disable`, {}],
      ["DELETE", `/user/${EMP_ID}`],
      ["POST", `/user/${EMP_ID}/permissions`, { permission_key: "manage_user_accounts" }],
    ];
    const before = JSON.stringify(rows.emp);
    for (const [m, p, b] of attempts) {
      const res = await call(m, p, b);
      assert.equal(res.status, 404, `${m} ${p} -> ${res.status}`);
    }
    assert.equal(JSON.stringify(rows.emp), before);
  });

  it("the /user router's route surface is enumerable; the only DELETE is the caller's own Telegram link", () => {
    delete require.cache[require.resolve("./user")];
    const routes = require("./user")({}, { require: () => (req, res, next) => next() }, null, {});
    const stack = routes.getRouter().stack.filter((l) => l.route);
    const listed = stack.map((l) => `${Object.keys(l.route.methods).join(",").toUpperCase()} ${l.route.path}`).sort();
    assert.deepEqual(listed, [
      "DELETE /telegram-link",
      "GET /:id(\\d+)/account",
      "GET /auth-log",
      "GET /auth-metrics",
      "GET /ip-restrictions",
      "GET /my-ip",
      "GET /telegram-link",
      "POST /:id(\\d+)/reset-password",
      "POST /:id(\\d+)/unlock",
      "POST /change-password",
      "POST /forgot-password",
      "POST /ip-restrictions",
      "POST /login",
      "POST /logout",
      "POST /reset-password",
      "POST /setup-password",
      "POST /telegram-link",
    ]);
    for (const l of stack) {
      assert.equal(l.route.methods.put, undefined);
      assert.equal(l.route.methods.patch, undefined);
      // No route deletes or rewrites an account. The one DELETE removes the
      // caller's own Telegram link (self-scoped via req.auth, no :id).
      if (l.route.methods.delete) assert.equal(l.route.path, "/telegram-link");
    }
  });

  // --- Merged Telegram reset routes (integration of main-autodeploy) --------

  it("forgot-password for the break-glass username is neutral, sends nothing, issues no code", async () => {
    const before = snapshot();
    const res = await call("POST", "/user/forgot-password", { username: rows.breakglass.username }, "");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, 200);
    assert.equal(telegram.sent.length, 0);
    assert.equal(resetRepo.codes.filter((c) => c.user_id === SYSTEM_ID).length, 0);
    assert.equal(snapshot(), before);
    const audit = authLog.events.filter((e) => e.event === "reset_requested").pop();
    assert.ok(audit && /unknown_user|refused_protected_or_inactive/.test(audit.detail), String(audit && audit.detail));
  });

  it("reset-password for the break-glass username is refused even with a planted valid code, row unchanged", async () => {
    // Plant a live code for the system row directly (as a DB-level attacker would).
    await resetRepo.createResetCode(SYSTEM_ID, sha256("123456"), new Date(Date.now() + 5 * 60 * 1000));
    const before = snapshot();
    const res = await call("POST", "/user/reset-password", { username: rows.breakglass.username, code: "123456", new_password: "totally-different-secret-99" }, "");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.notEqual(body.code, 200);
    assert.equal(snapshot(), before);
    assert.equal(userRepo.calls.some((c) => c[0] === "setModernPassword" && c[1] === SYSTEM_ID), false);
  });

  it("a normal admin cannot route a Telegram reset at the break-glass account (no username override, no :id form)", async () => {
    const before = snapshot();
    const r1 = await call("POST", "/user/forgot-password", { username: rows.breakglass.username });
    assert.equal(r1.status, 200); // neutral, and nothing happened
    assert.equal(telegram.sent.length, 0);
    const r2 = await call("POST", `/user/${SYSTEM_ID}/forgot-password`, {});
    assert.equal(r2.status, 404);
    const r3 = await call("POST", `/user/${SYSTEM_ID}/telegram-link`, {});
    assert.equal(r3.status, 404);
    assert.equal(snapshot(), before);
    assert.equal(Object.keys(resetRepo.links).length, 0);
  });

  it("a system-account session is refused on every /telegram-link method (403 EMPLOYEE_REQUIRED)", async () => {
    for (const m of ["GET", "POST", "DELETE"]) {
      const res = await call(m, "/user/telegram-link", m === "GET" ? undefined : {}, systemToken);
      assert.equal(res.status, 403, `${m} -> ${res.status}`);
      assert.equal((await res.json()).error, "EMPLOYEE_REQUIRED");
    }
    assert.equal(Object.keys(resetRepo.links).length, 0);
    assert.equal(resetRepo.linkTokens, undefined, "no link token was created for the system account");
  });

  it("a normal employee session CAN start a Telegram link (the guard is specific)", async () => {
    const empToken = await jwtService.sign({ auth_ver: 2, id: EMP_ID, employee_id: 1002, user_type: 1, designation_id: 4, store_id: 2 }, "1h", { subject: String(EMP_ID) });
    const res = await call("POST", "/user/telegram-link", {}, empToken);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.link, /^https:\/\/t\.me\/dnds_test_bot\?start=[0-9a-f]{48}$/);
    assert.equal(resetRepo.linkTokens.length, 1);
    assert.equal(resetRepo.linkTokens[0].userId, EMP_ID);
  });

  it("an admin CAN reset and unlock a normal employee (the guard is specific, not a blanket refusal)", async () => {
    const res = await call("POST", `/user/${EMP_ID}/reset-password`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.setup_token);
    assert.equal(rows.emp.must_change_password, 1);
    const un = await call("POST", `/user/${EMP_ID}/unlock`);
    assert.equal(un.status, 200);
  });

  it("every refusal is audited nowhere as a success and the system row is byte-for-byte unchanged", () => {
    assert.equal(rows.breakglass.is_system_account, 1);
    assert.equal(rows.breakglass.employee_id, null);
    assert.equal(rows.breakglass.ip_policy, "unrestricted");
    assert.equal(authLog.events.some((e) => e.event === "admin_reset_issued" && e.userId === SYSTEM_ID), false);
    assert.equal(authLog.events.some((e) => e.event === "account_unlocked" && e.userId === SYSTEM_ID), false);
  });
});
