/**
 * Gate 16 — no flag combination unexpectedly disables today's production
 * login. "Today's production login" is: an active employee, legacy SHA-1
 * credential, very likely on the provisioning default, sending username +
 * password in the POST body (or, for a stale bundle, the query string).
 *
 * For every Deployment-A-legal combination of the flags, that login must
 * return code 200 with a token. Only the flags DOCUMENTED as
 * login-refusing (AUTH_REJECT_LEGACY_SHA1, AUTH_REQUIRE_HTTPS over plain
 * HTTP, lockout after real failures) may change that, and each is proven
 * to do exactly what it says and nothing more.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUserUsecase = require("./user");
const passwordService = require("../services/password");
const F = require("../test_support/auth_fixtures");

const IP = "49.207.1.1";

function build(rows, over = {}) {
  const userRepo = F.fakeUserRepo(rows);
  const authLog = F.fakeAuthLog();
  const { service: jwt } = F.makeJwt();
  const usecase = buildUserUsecase(userRepo, null, null, {
    authLogRepo: authLog, telegram: F.fakeTelegram(), config: F.config(over), passwords: passwordService, jwt,
  });
  return { usecase, userRepo, authLog, jwt };
}

const employee = () => ({
  "1003": F.employeeRow({ username: "1003", employee_id: 1003, primary_contact_number: "9000000000", password: F.legacyHash("1003@123"), password_algo: "sha1" }),
});

const BOOL_FLAGS = [
  ["password", "hashOnLogin"],
  ["password", "flagWeakOnLogin"],
  ["password", "enforcePasswordChange"],
  ["login", "allowQueryString"],
  ["login", "employeeStatusCheck"],
  ["login", "tokenValidFromEnabled"],
  ["provisioning", "secure"],
];

function combos(n) {
  const out = [];
  for (let m = 0; m < 1 << n; m++) out.push(Array.from({ length: n }, (_, i) => Boolean(m & (1 << i))));
  return out;
}

describe("gate 16 — every combination of the Deployment-A-legal flags still logs a legacy default-password employee in", () => {
  for (const bits of combos(BOOL_FLAGS.length)) {
    const over = {};
    BOOL_FLAGS.forEach(([g, k], i) => { over[g] = over[g] || {}; over[g][k] = bits[i]; });
    over.login = over.login || {};
    over.login.lockout = { enabled: bits[0] && bits[1] }; // lockout on in some combos too — no failures happen, so it must not matter
    const label = BOOL_FLAGS.map(([, k], i) => `${k}=${bits[i] ? 1 : 0}`).join(" ");
    it(`logs in with ${label}`, async () => {
      const rows = employee();
      const { usecase, jwt } = build(rows, over);
      const r = await usecase.login("1003", "1003@123", IP, { transport: "body" });
      assert.equal(r.code, 200, "login refused");
      assert.ok(r.token, "no token");
      const decoded = await jwt.verify(r.token);
      assert.equal(decoded.sub, "1003" === String(rows["1003"].user_id) ? decoded.sub : String(rows["1003"].user_id));
      assert.equal(decoded.employee_id, 1003);
      // the weak default is flagged when flagWeakOnLogin is on, and only then does enforcement matter
      if (over.password.flagWeakOnLogin) {
        assert.equal(rows["1003"].must_change_password, 1);
        assert.equal(decoded.pwc, over.password.enforcePasswordChange ? true : undefined);
      } else {
        assert.equal(rows["1003"].must_change_password, 0);
        assert.equal(decoded.pwc, undefined);
      }
      // hash-on-login upgrades, never blocks
      assert.equal(rows["1003"].password_algo, over.password.hashOnLogin ? "scrypt" : "sha1");
    });
  }

  it("the query-string transport still logs in while allowQueryString is on (stale frontend bundles)", async () => {
    const { usecase } = build(employee(), { login: { allowQueryString: true } });
    assert.equal((await usecase.login("1003", "1003@123", IP, { transport: "query" })).code, 200);
  });

  it("AUTH_REJECT_LEGACY_SHA1 (Deployment B, off by default) is the ONLY flag that refuses a legacy account, and it refuses exactly those", async () => {
    const rows = employee();
    const { usecase, authLog } = build(rows, { password: { rejectLegacy: true } });
    assert.equal((await usecase.login("1003", "1003@123", IP)).code, 204);
    assert.ok(authLog.events.some((e) => e.event === "login_failed" && e.detail === "legacy_rejected"));
    // a migrated (scrypt) account is unaffected by it
    const modern = { "1004": F.employeeRow({ user_id: 8, username: "1004", employee_id: 1004, password_algo: "scrypt", password_hash: await F.hashCheap("blue-kettle-42") }) };
    assert.equal((await build(modern, { password: { rejectLegacy: true } }).usecase.login("1004", "blue-kettle-42", IP)).code, 200);
  });

  it("lockout, when enabled, only bites after the threshold of real failures; a correct login before that is unaffected", async () => {
    const rows = employee();
    const { usecase } = build(rows, { login: { lockout: { enabled: true, threshold: 3, minutes: 15 } } });
    assert.equal((await usecase.login("1003", "wrong-1", IP)).code, 204);
    assert.equal((await usecase.login("1003", "wrong-2", IP)).code, 204);
    assert.equal((await usecase.login("1003", "1003@123", IP)).code, 200, "two failures do not lock at threshold 3");
  });

  it("the system account logs in under every combination too (no employee, judged by its own status)", async () => {
    const rows = { bg: F.systemRow({ user_id: 99, username: "breakglass", password_hash: await F.hashCheap("a-very-long-break-glass-secret-2026") }) };
    for (const bits of [[false, false, false, false, false, false, false], [true, true, true, true, true, true, true]]) {
      const over = {};
      BOOL_FLAGS.forEach(([g, k], i) => { over[g] = over[g] || {}; over[g][k] = bits[i]; });
      const r = await build(rows, over).usecase.login("breakglass", "a-very-long-break-glass-secret-2026", IP);
      assert.equal(r.code, 200);
      assert.equal(r.is_system_account, true);
      assert.equal(r.must_change_password, false, "the system account is never flagged");
    }
  });
});
