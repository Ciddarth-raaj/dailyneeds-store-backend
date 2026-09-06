const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const jsonwebtoken = require("jsonwebtoken");
const buildUserUsecase = require("./user");
const passwordService = require("../services/password");
const F = require("../test_support/auth_fixtures");

const IP = "49.207.1.1";

/** Build a usecase over a set of rows with explicit flags and a real JWT. */
function build(rows, over = {}) {
  const userRepo = F.fakeUserRepo(rows);
  const authLog = F.fakeAuthLog();
  const telegram = F.fakeTelegram();
  const { service: jwt } = F.makeJwt();
  const passwords = over.passwords || passwordService;
  const usecase = buildUserUsecase(userRepo, null, null, {
    authLogRepo: authLog,
    telegram,
    config: F.config(over.config || {}),
    passwords,
    jwt,
    now: over.now,
  });
  return { usecase, userRepo, authLog, telegram, jwt };
}

const legacyRows = () => ({ "1003": F.employeeRow({ password: F.legacyHash("legacy-pass-1"), password_algo: "sha1" }) });

describe("login — legacy and modern verification (A2, B1)", () => {
  it("1. a legacy SHA-1 user can log in before migration, and stays SHA-1", async () => {
    const { usecase, userRepo } = build(legacyRows());
    const r = await usecase.login("1003", "legacy-pass-1", IP);
    assert.equal(r.code, 200);
    assert.ok(r.token);
    assert.equal(userRepo.calls.some((c) => c[0] === "migrateLegacyPassword"), false);
  });

  it("2. with hash-on-login on, a successful legacy login upgrades the hash", async () => {
    const rows = legacyRows();
    const { usecase, userRepo, authLog } = build(rows, { config: { password: { hashOnLogin: true } } });
    const r = await usecase.login("1003", "legacy-pass-1", IP);
    assert.equal(r.code, 200);
    assert.equal(rows["1003"].password_algo, "scrypt");
    assert.equal(rows["1003"].password, null);
    assert.ok(rows["1003"].password_hash.startsWith("$scrypt$"));
    assert.ok(authLog.has("password_migrated"));
    assert.ok(userRepo.calls.some((c) => c[0] === "migrateLegacyPassword"));
  });

  it("3. a migrated account authenticates with the modern hash", async () => {
    const rows = { "1003": F.employeeRow({ password_algo: "scrypt", password_hash: await F.hashCheap("modern-pass-1") }) };
    const r = await build(rows).usecase.login("1003", "modern-pass-1", IP);
    assert.equal(r.code, 200);
  });

  it("4. a modern account never falls back to SHA-1", async () => {
    const rows = {
      "1003": F.employeeRow({
        password_algo: "scrypt",
        password_hash: await F.hashCheap("modern-pass-1"),
        password: F.legacyHash("old-sha1-pass"), // stale column left behind
      }),
    };
    const r = await build(rows).usecase.login("1003", "old-sha1-pass", IP);
    assert.equal(r.code, 204);
  });

  it("5. a wrong password fails", async () => {
    const r = await build(legacyRows()).usecase.login("1003", "nope", IP);
    assert.equal(r.code, 204);
  });

  it("18. a flagged default-password account keeps must_change_password after automatic migration", async () => {
    const rows = { "1003": F.employeeRow({ password: F.legacyHash("1003@123"), password_algo: "sha1", must_change_password: 1, password_flag_reason: "default_scan" }) };
    const { usecase } = build(rows, { config: { password: { hashOnLogin: true } } });
    const r = await usecase.login("1003", "1003@123", IP);
    assert.equal(r.code, 200);
    assert.equal(rows["1003"].password_algo, "scrypt");
    assert.equal(rows["1003"].must_change_password, 1);
    assert.equal(r.must_change_password, true);
  });

  it("legacy accounts are refused outright once AUTH_REJECT_LEGACY_SHA1 is on", async () => {
    const r = await build(legacyRows(), { config: { password: { rejectLegacy: true } } }).usecase.login("1003", "legacy-pass-1", IP);
    assert.equal(r.code, 204);
  });
});

describe("login — enumeration and timing (B8)", () => {
  it("6. an unknown username gives the same response as a wrong password", async () => {
    const { usecase } = build(legacyRows());
    const unknown = await usecase.login("no-such-user", "x", IP);
    const wrong = await usecase.login("1003", "x", IP);
    assert.deepEqual(unknown, wrong);
  });

  it("7. an unknown username performs a dummy hash verification", async () => {
    let dummyCalls = 0;
    const passwords = { ...passwordService, dummyVerify: async () => (dummyCalls++, false) };
    const { usecase } = build(legacyRows(), { passwords });
    await usecase.login("no-such-user", "x", IP);
    assert.equal(dummyCalls, 1);
  });

  it("a disabled account and an inactive employee also answer identically", async () => {
    const rows = {
      disabled: F.employeeRow({ user_id: 11, username: "disabled", status: 0, password: F.legacyHash("p1234567") }),
      left: F.employeeRow({ user_id: 12, username: "left", employee_status: 0, password: F.legacyHash("p1234567") }),
    };
    const { usecase, authLog } = build(rows);
    assert.deepEqual(await usecase.login("disabled", "p1234567", IP), { code: 204 });
    assert.deepEqual(await usecase.login("left", "p1234567", IP), { code: 204 });
    assert.ok(authLog.events.filter((e) => e.event === "login_inactive").length === 2);
  });
});

describe("login — lockout (B7)", () => {
  const lockCfg = { login: { lockout: { enabled: true, threshold: 3, minutes: 15, ipThreshold: 100 } } };

  it("8. the account locks after the threshold and stays locked even with the right password", async () => {
    const rows = legacyRows();
    const { usecase, authLog } = build(rows, { config: lockCfg });
    for (let i = 0; i < 3; i++) assert.equal((await usecase.login("1003", "wrong", IP)).code, 204);
    assert.ok(rows["1003"].locked_until, "locked_until should be set");
    assert.equal((await usecase.login("1003", "legacy-pass-1", IP)).code, 204);
    assert.ok(authLog.has("login_locked"));
  });

  it("9. an authorised unlock clears the lock and login works again", async () => {
    const rows = legacyRows();
    const { usecase, authLog } = build(rows, { config: lockCfg });
    for (let i = 0; i < 3; i++) await usecase.login("1003", "wrong", IP);
    const r = await usecase.unlock(7, 1, { ip: IP });
    assert.equal(r.code, 200);
    assert.equal(rows["1003"].locked_until, null);
    assert.equal((await usecase.login("1003", "legacy-pass-1", IP)).code, 200);
    assert.ok(authLog.events.some((e) => e.event === "account_unlocked" && e.actorUserId === 1));
  });

  it("10. shared-IP users are not all blocked because one user fails", async () => {
    const rows = {
      "1003": F.employeeRow({ password: F.legacyHash("legacy-pass-1") }),
      "1004": F.employeeRow({ user_id: 8, username: "1004", employee_id: 1004, password: F.legacyHash("other-pass-1") }),
    };
    const { usecase } = build(rows, { config: lockCfg });
    for (let i = 0; i < 3; i++) await usecase.login("1003", "wrong", IP);
    assert.equal((await usecase.login("1004", "other-pass-1", IP)).code, 200, "colleague behind the same NAT still signs in");
  });

  it("the loose per-IP throttle only trips after many failures", async () => {
    const rows = { "1003": F.employeeRow({ password: F.legacyHash("legacy-pass-1") }) };
    const cfg = { login: { lockout: { enabled: true, threshold: 1000, ipThreshold: 5, ipBlockMinutes: 5 } } };
    const { usecase } = build(rows, { config: cfg });
    for (let i = 0; i < 5; i++) await usecase.login("ghost", "x", IP);
    assert.equal((await usecase.login("1003", "legacy-pass-1", IP)).code, 204, "blocked from this address");
    assert.equal((await usecase.login("1003", "legacy-pass-1", "198.51.100.9")).code, 200, "another address is fine");
  });

  it("a successful login resets the failure counter", async () => {
    const rows = legacyRows();
    const { usecase } = build(rows, { config: lockCfg });
    await usecase.login("1003", "wrong", IP);
    assert.equal(rows["1003"].failed_login_count, 1);
    await usecase.login("1003", "legacy-pass-1", IP);
    assert.equal(rows["1003"].failed_login_count, 0);
  });
});

describe("login — break-glass / system account (A4, A5, C2, C3)", () => {
  const rows = async () => ({
    breakglass: F.systemRow({ password_hash: await F.hashCheap("a-very-long-break-glass-secret-2026") }),
    "1003": F.employeeRow({ password: F.legacyHash("legacy-pass-1") }),
  });

  it("24. a system account with employee_id NULL can log in", async () => {
    const { usecase } = build(await rows());
    const r = await usecase.login("breakglass", "a-very-long-break-glass-secret-2026", IP);
    assert.equal(r.code, 200);
    assert.equal(r.is_system_account, true);
    assert.equal(r.employee_id, null);
  });

  it("25. the JWT sub for a system account is the user-table primary key, with no employee_id claim", async () => {
    const { usecase } = build(await rows());
    const r = await usecase.login("breakglass", "a-very-long-break-glass-secret-2026", IP);
    const claims = jsonwebtoken.decode(r.token);
    assert.equal(claims.sub, "99");
    assert.equal(claims.sys, true);
    assert.equal("employee_id" in claims, false);
  });

  it("26. a normal employee's JWT carries sub = user_id and the unchanged employee_id", async () => {
    const { usecase } = build(await rows());
    const r = await usecase.login("1003", "legacy-pass-1", IP);
    const claims = jsonwebtoken.decode(r.token);
    assert.equal(claims.sub, "7");
    assert.equal(claims.employee_id, 1003);
    assert.equal(claims.id, 7);
    assert.equal(claims.sys, undefined);
  });

  it("45. a break-glass login sends an immediate alert and is audited", async () => {
    const { usecase, telegram, authLog } = build(await rows());
    await usecase.login("breakglass", "a-very-long-break-glass-secret-2026", IP);
    assert.equal(telegram.sent.length, 1);
    assert.match(telegram.sent[0].msg, /BREAK-GLASS LOGIN/);
    assert.equal(telegram.sent[0].opts.disableNotification, false);
    assert.ok(authLog.has("break_glass_login"));
  });

  it("a failed break-glass login is audited separately and alerts", async () => {
    const { usecase, telegram, authLog } = build(await rows());
    await usecase.login("breakglass", "wrong-wrong-wrong-wrong", IP);
    assert.ok(authLog.has("break_glass_login_failed"));
    assert.equal(telegram.sent.length, 1);
  });

  it("23. an inactive employee cannot log in, but the system account does not depend on any employee status", async () => {
    const r = await rows();
    r["1003"].employee_status = 0;
    const { usecase } = build(r);
    assert.equal((await usecase.login("1003", "legacy-pass-1", IP)).code, 204);
    assert.equal((await usecase.login("breakglass", "a-very-long-break-glass-secret-2026", IP)).code, 200);
  });

  it("a non-system account with no employee row still cannot log in (no silent widening)", async () => {
    const r = { orphan: F.employeeRow({ user_id: 5, username: "orphan", employee_id: null, employee_status: null, user_type: 2, password: F.legacyHash("p1234567") }) };
    assert.equal((await build(r).usecase.login("orphan", "p1234567", IP)).code, 204);
  });

  it("27/29. normal APIs cannot change, reset, unlock or re-policy a system account", async () => {
    const r = await rows();
    const { usecase } = build(r);
    await assert.rejects(() => usecase.changePassword(99, "a-very-long-break-glass-secret-2026", "another-long-secret-xyz"), (e) => e.code === "SYSTEM_ACCOUNT");
    await assert.rejects(() => usecase.issueReset(99, 1, { ip: IP }), (e) => e.code === "SYSTEM_ACCOUNT");
    await assert.rejects(() => usecase.unlock(99, 1, { ip: IP }), (e) => e.code === "SYSTEM_ACCOUNT");
    // the repository guard mirrors the SQL guard: no mutation lands
    await usecase.updateIpPolicy(99, "", "branch");
    assert.equal(r.breakglass.ip_policy, "unrestricted");
  });

  it("28. no API path can create a system account: createLogin has no such parameter and the flag defaults to 0", async () => {
    const r = await rows();
    const { userRepo } = build(r);
    await userRepo.createLogin("newuser", "2", 2001, await F.hashCheap("x-y-z-w-1234"), { is_system_account: 1, isSystemAccount: true });
    assert.equal(r.newuser.is_system_account, 0);
    assert.equal(r.newuser.user_type, 2);
  });

  it("46. a break-glass credential rotation event is an accepted audit event", async () => {
    const authLog = require("../repository/auth_log");
    assert.ok(authLog.EVENTS.includes("break_glass_credential_rotated"));
    assert.ok(authLog.EVENTS.includes("system_account_created"));
    assert.ok(authLog.EVENTS.includes("break_glass_rotation_due"));
  });
});

describe("login — transport (A7, A8)", () => {
  it("14/15. login is audited with the transport but never with the password", async () => {
    const { usecase, authLog } = build(legacyRows());
    await usecase.login("1003", "legacy-pass-1", IP, { transport: "query" });
    const success = authLog.events.find((e) => e.event === "login_success");
    assert.equal(success.detail, "legacy_query_string");
    const dumped = JSON.stringify(authLog.events);
    assert.equal(dumped.includes("legacy-pass-1"), false);
  });

  it("refuses credentials over plaintext when AUTH_REQUIRE_HTTPS is on", async () => {
    const { usecase, authLog } = build(legacyRows(), { config: { login: { requireHttps: true } } });
    const r = await usecase.login("1003", "legacy-pass-1", IP, { secure: false });
    assert.equal(r.error, "INSECURE_TRANSPORT");
    assert.ok(authLog.has("login_insecure_transport"));
    assert.equal((await usecase.login("1003", "legacy-pass-1", IP, { secure: true })).code, 200);
  });
});

describe("change password and setup tokens (B3–B6)", () => {
  it("16. a new password is always stored as a modern hash", async () => {
    const rows = legacyRows();
    const { usecase } = build(rows);
    const r = await usecase.changePassword(7, "legacy-pass-1", "blue-kettle-42");
    assert.equal(r.code, 200);
    assert.equal(rows["1003"].password_algo, "scrypt");
    assert.equal(rows["1003"].password, null);
    assert.ok(rows["1003"].password_hash.startsWith("$scrypt$"));
  });

  it("17. a predictable new password is rejected", async () => {
    const { usecase } = build(legacyRows());
    await assert.rejects(() => usecase.changePassword(7, "legacy-pass-1", "1003@123"), (e) => e.name === "ValidationError");
    await assert.rejects(() => usecase.changePassword(7, "legacy-pass-1", "9000000000"), (e) => e.name === "ValidationError");
  });

  it("a wrong current password is refused and does not change anything", async () => {
    const rows = legacyRows();
    const r = await build(rows).usecase.changePassword(7, "wrong", "blue-kettle-42");
    assert.equal(r.error, "INCORRECT_PASSWORD");
    assert.equal(rows["1003"].password_algo, "sha1");
  });

  it("changing the password clears must_change_password", async () => {
    const rows = { "1003": F.employeeRow({ password: F.legacyHash("legacy-pass-1"), must_change_password: 1, password_flag_reason: "default_scan" }) };
    await build(rows).usecase.changePassword(7, "legacy-pass-1", "blue-kettle-42");
    assert.equal(rows["1003"].must_change_password, 0);
  });

  it("admin reset issues a single-use token once, flags the account, and never sees the password", async () => {
    const rows = legacyRows();
    const { usecase, userRepo, authLog } = build(rows);
    const r = await usecase.issueReset(7, 1, { ip: IP });
    assert.equal(r.code, 200);
    assert.ok(r.setup_token.length >= 32);
    assert.equal(rows["1003"].must_change_password, 1);
    assert.equal(userRepo.tokens.length, 1);
    assert.notEqual(userRepo.tokens[0].token_hash, r.setup_token, "only the hash is stored");
    assert.ok(authLog.events.some((e) => e.event === "admin_reset_issued" && e.actorUserId === 1));
  });

  it("redeeming a token sets a modern password and consumes it", async () => {
    const rows = legacyRows();
    const { usecase } = build(rows);
    const { setup_token } = await usecase.issueReset(7, 1, { ip: IP });
    const r = await usecase.redeemSetupToken(setup_token, "blue-kettle-42", { ip: IP });
    assert.equal(r.code, 200);
    assert.equal(rows["1003"].password_algo, "scrypt");
    assert.equal(rows["1003"].must_change_password, 0);
    assert.equal((await usecase.login("1003", "blue-kettle-42", IP)).code, 200);
  });

  it("20/21. a token is single use", async () => {
    const { usecase } = build(legacyRows());
    const { setup_token } = await usecase.issueReset(7, 1, { ip: IP });
    await usecase.redeemSetupToken(setup_token, "blue-kettle-42", { ip: IP });
    await assert.rejects(() => usecase.redeemSetupToken(setup_token, "green-lamp-77", { ip: IP }), (e) => e.code === "TOKEN_INVALID");
  });

  it("19. a token expires", async () => {
    const later = new Date(Date.now() + 31 * 60 * 1000);
    const { usecase } = build(legacyRows(), { now: () => new Date() });
    const { setup_token } = await usecase.issueReset(7, 1, { ip: IP });
    usecase.now = () => later;
    await assert.rejects(() => usecase.redeemSetupToken(setup_token, "blue-kettle-42", { ip: IP }), (e) => e.code === "TOKEN_INVALID");
  });

  it("issuing a new token invalidates the previous one", async () => {
    const { usecase } = build(legacyRows());
    const first = (await usecase.issueReset(7, 1, { ip: IP })).setup_token;
    const second = (await usecase.issueReset(7, 1, { ip: IP })).setup_token;
    await assert.rejects(() => usecase.redeemSetupToken(first, "blue-kettle-42", { ip: IP }));
    assert.equal((await usecase.redeemSetupToken(second, "blue-kettle-42", { ip: IP })).code, 200);
  });

  it("an unknown token is refused with the same error", async () => {
    const { usecase } = build(legacyRows());
    await assert.rejects(() => usecase.redeemSetupToken("A".repeat(43), "blue-kettle-42", { ip: IP }), (e) => e.code === "TOKEN_INVALID");
  });

  it("a redeemed password must still satisfy policy", async () => {
    const { usecase } = build(legacyRows());
    const { setup_token } = await usecase.issueReset(7, 1, { ip: IP });
    await assert.rejects(() => usecase.redeemSetupToken(setup_token, "1003@123", { ip: IP }), (e) => e.name === "ValidationError");
  });
});

describe("logout and revocation (C4, C5)", () => {
  it("logout stamps token_valid_from and is audited", async () => {
    const rows = legacyRows();
    const { usecase, authLog } = build(rows);
    await usecase.logout(7, { ip: IP });
    assert.ok(rows["1003"].token_valid_from instanceof Date);
    assert.ok(authLog.has("logout"));
  });
});
