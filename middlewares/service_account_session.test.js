/**
 * DN-TALLY-INTEGRATION-AUTH-FIX R1. A service account's SESSION, as opposed
 * to its revocation.
 *
 * Excluding integration accounts from employee-wide `token_valid_from`
 * revocation was only half of the coupling. Two more paths read the linked
 * employee on every request:
 *
 *   employeeActive()  employee 1 becoming inactive refused the integration
 *                     with EMPLOYEE_INACTIVE, on the legacy path and on
 *                     Gate 14 alike;
 *   getIpPolicy()     the integration inherited employee 1's outlet's IP
 *                     rule, so moving that employee - or switching that
 *                     outlet's restriction on - locked the integration out
 *                     with IP_NOT_ALLOWED.
 *
 * Both are fixed here, and both are fixed WITHOUT reusing
 * `is_system_account` and without cutting the employee link the already
 * installed legacy token depends on.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-svc-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ "test-kid": path.join(dir, "pub.key") });
process.env.JWT_ACTIVE_KID = "test-kid";
process.env.JWT_LEGACY_KID = "test-kid";
process.env.JWT_TOKEN_CUTOFF = "0";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const F = require("../test_support/auth_fixtures");
const auth = require("./auth");
const jwtService = require("../services/jwt");
const ipRestriction = require("./ip_restriction");
const { resolveIpPolicy, isAccessAllowed } = require("../utils/ip");

const run = (mw, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(s) {
        this.statusCode = s;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
      end() {
        resolve({ nexted: false, res, req });
      },
    };
    mw(req, res, () => resolve({ nexted: true, res, req }));
  });

const reqFor = (token, p = "/tally/purchase", method = "GET") => ({
  path: p,
  method,
  headers: token ? { "x-access-token": token } : {},
});

/**
 * The production shape: user 198, `purchase_api`, still carrying employee 1,
 * with that employee INACTIVE - the case that would take Tally down next.
 */
const sessionState = ({ service = 0, employeeStatus = 0, status = 1, employeeId = 1 } = {}) => ({
  getSessionState: async () => ({
    user_id: 198,
    employee_id: employeeId,
    status,
    token_valid_from: null,
    must_change_password: 0,
    is_system_account: 0,
    is_service_account: service,
    employee_status: employeeStatus,
  }),
});

const cfg = () => F.config({ login: { employeeStatusCheck: true, tokenValidFromEnabled: true, tokenValidFromCacheMs: 0 } });

const legacyToken = () => jwtService.sign({ id: 198, employee_id: 1, user_type: 1 }, "1h");
const modernToken = () => jwtService.sign({ auth_ver: 2, id: 198, employee_id: 1, user_type: 1 }, "1h", { subject: "198" });

describe("employee status does not decide a service account's session", () => {
  it("legacy token, service account, linked employee INACTIVE → allowed", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 0 }), config: cfg() });
    const { nexted } = await run(mw, reqFor(await legacyToken()));
    assert.equal(nexted, true, "the Tally bridge must survive employee 1 resigning");
  });

  it("legacy token, HUMAN account, linked employee INACTIVE → denied", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 0, employeeStatus: 0 }), config: cfg() });
    const { nexted, res } = await run(mw, reqFor(await legacyToken()));
    assert.equal(nexted, false);
    assert.equal(res.body.error, "EMPLOYEE_INACTIVE");
  });

  it("auth_ver 2 token, service account, linked employee INACTIVE → allowed", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 0 }), config: cfg() });
    assert.equal((await run(mw, reqFor(await modernToken()))).nexted, true);
  });

  it("auth_ver 2 token, HUMAN account, linked employee INACTIVE → denied", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 0, employeeStatus: 0 }), config: cfg() });
    const { nexted, res } = await run(mw, reqFor(await modernToken()));
    assert.equal(nexted, false);
    assert.equal(res.body.error, "EMPLOYEE_INACTIVE");
  });

  it("a human with an ACTIVE employee is unaffected either way", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 0, employeeStatus: 1 }), config: cfg() });
    assert.equal((await run(mw, reqFor(await legacyToken()))).nexted, true);
    assert.equal((await run(mw, reqFor(await modernToken()))).nexted, true);
  });

  it("DISABLING the account still stops the integration - status is the kill switch", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 1, status: 0 }), config: cfg() });
    assert.equal((await run(mw, reqFor(await legacyToken()))).nexted, false);
    assert.equal((await run(mw, reqFor(await modernToken()))).nexted, false);
  });

  it("the legacy token's employee_id claim is still checked against the row", async () => {
    // Which is exactly why `purchase_api` keeps employee_id = 1 for now:
    // cutting the link would invalidate the token already on the Tally
    // machine.
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 1, employeeId: 77 }), config: cfg() });
    assert.equal((await run(mw, reqFor(await legacyToken()))).nexted, false);
  });

  it("a service account is NOT a system account: `sys` is still refused for it", async () => {
    // Service-account-ness is read from the row, never claimed by a token.
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 1 }), config: cfg() });
    const sysToken = await jwtService.sign({ auth_ver: 2, id: 198, user_type: 1, sys: true }, "1h", { subject: "198" });
    const { req } = await run(mw, reqFor(sysToken));
    assert.equal(req.auth.isSystemAccount, true);
    assert.strictEqual(req.auth.employeeId, null, "a sys token never carries an employee, flagged row or not");
  });
});

describe("token_valid_from = NULL is not an expiry bypass", () => {
  it("an expired JWT is still refused when token_valid_from is NULL", async () => {
    // The temporary recovery for Tally clears `token_valid_from`. That means
    // "no revocation cut-off recorded" and nothing else: `exp` is verified
    // by the JWT layer before the session state is ever read.
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 1 }), config: cfg() });
    const expired = await jwtService.sign({ id: 198, employee_id: 1, user_type: 1 }, "-10s");
    const { nexted, res } = await run(mw, reqFor(expired));
    assert.equal(nexted, false, "an expired token must never be accepted");
    assert.equal(res.body.code, 403);
  });

  it("the same account with an unexpired token is accepted, so the test above proves expiry and nothing else", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 1 }), config: cfg() });
    assert.equal((await run(mw, reqFor(await legacyToken()))).nexted, true);
  });

  it("an expired auth_ver 2 token is refused too", async () => {
    const mw = auth.create({ userUsecase: sessionState({ service: 1, employeeStatus: 1 }), config: cfg() });
    const expired = await jwtService.sign({ auth_ver: 2, id: 198, employee_id: 1, user_type: 1 }, "-10s", { subject: "198" });
    assert.equal((await run(mw, reqFor(expired))).nexted, false);
  });
});

/* ------------------------------------------------------------------------ *
 * IP policy.
 * ------------------------------------------------------------------------ */
describe("a service account does not inherit its employee's branch IP policy", () => {
  const humanOnRestrictedBranch = { user_type: 1, ip_policy: "branch", branch_enabled: 1, branch_ips: "10.0.0.1" };

  it("a human still follows the branch, allowed and blocked alike", () => {
    const resolved = resolveIpPolicy(humanOnRestrictedBranch);
    assert.equal(resolved.source, "branch");
    assert.equal(isAccessAllowed(resolved, "10.0.0.1"), true);
    assert.equal(isAccessAllowed(resolved, "203.0.113.9"), false);
  });

  it("a human on a branch with the switch off is exempt, exactly as before", () => {
    assert.equal(resolveIpPolicy({ user_type: 1, ip_policy: "branch", branch_enabled: 0 }).exempt, true);
  });

  it("a service account ignores the branch columns entirely", () => {
    // Same row, same branch, one flag different.
    const resolved = resolveIpPolicy({ ...humanOnRestrictedBranch, is_service_account: 1 });
    assert.notEqual(resolved.source, "branch");
    assert.deepEqual(resolved.rules, [], "a branch rule must never leak into a service account's policy");
  });

  it("changing the linked employee's branch does not change a service account's answer", () => {
    const a = resolveIpPolicy({ is_service_account: 1, ip_policy: "custom", allowed_ips: "203.0.113.7", branch_enabled: 0, branch_ips: null });
    const b = resolveIpPolicy({ is_service_account: 1, ip_policy: "custom", allowed_ips: "203.0.113.7", branch_enabled: 1, branch_ips: "10.0.0.0/8" });
    assert.deepEqual(a, b);
    assert.equal(isAccessAllowed(b, "10.0.0.5"), false, "the employee's branch must not admit the integration");
    assert.equal(isAccessAllowed(b, "203.0.113.7"), true);
  });

  it("an explicit per-account allow list works, and only for the addresses it names", () => {
    const resolved = resolveIpPolicy({ is_service_account: 1, ip_policy: "custom", allowed_ips: "203.0.113.7, 198.51.100.0/24" });
    assert.equal(resolved.source, "service-custom");
    assert.equal(isAccessAllowed(resolved, "203.0.113.7"), true);
    assert.equal(isAccessAllowed(resolved, "198.51.100.44"), true);
    assert.equal(isAccessAllowed(resolved, "203.0.113.8"), false);
  });

  it("an UNCONFIGURED service account is refused, not exempted", () => {
    // `branch` is the column default, so this is what an account flagged
    // without a decision gets. It must fail closed: an integration that is
    // wrong about its network is an outage, an integration that is
    // accidentally reachable from anywhere is an incident.
    const resolved = resolveIpPolicy({ is_service_account: 1, ip_policy: "branch" });
    assert.equal(resolved.source, "service-unconfigured");
    assert.equal(resolved.exempt, false);
    assert.equal(isAccessAllowed(resolved, "203.0.113.7"), false);
    assert.equal(isAccessAllowed(resolved, "10.0.0.1"), false);
  });

  it("a service account gets no ADMIN exemption from its user_type either", () => {
    const resolved = resolveIpPolicy({ is_service_account: 1, ip_policy: "branch", user_type: 0 });
    assert.equal(resolved.exempt, false);
  });

  it("'unrestricted' still works, but has to be said", () => {
    assert.equal(resolveIpPolicy({ is_service_account: 1, ip_policy: "unrestricted" }).exempt, true);
  });

  it("the middleware blocks an unconfigured service account and admits a configured one", async () => {
    const policyFor = (row) => ({ getIpPolicy: async () => resolveIpPolicy(row) });
    const reqAt = (ip) => ({ decoded: { id: 198 }, path: "/tally/purchase", headers: { "x-forwarded-for": ip }, socket: { remoteAddress: ip }, connection: { remoteAddress: ip } });

    // The IP middleware answers with `res.json(...)` and no `end()`, so it
    // gets a runner that resolves on either.
    const runIp = (mw, req) =>
      new Promise((resolve) => {
        const res = {
          statusCode: 200,
          status(s) {
            this.statusCode = s;
            return this;
          },
          json(b) {
            resolve({ nexted: false, res: { ...this, body: b } });
            return this;
          },
          end() {},
        };
        mw(req, res, () => resolve({ nexted: true, res }));
      });

    const unconfigured = ipRestriction(policyFor({ is_service_account: 1, ip_policy: "branch" }));
    const blocked = await runIp(unconfigured, reqAt("203.0.113.7"));
    assert.equal(blocked.nexted, false);
    assert.equal(blocked.res.body.error, "IP_NOT_ALLOWED");

    const configured = ipRestriction(policyFor({ is_service_account: 1, ip_policy: "custom", allowed_ips: "203.0.113.7" }));
    assert.equal((await runIp(configured, reqAt("203.0.113.7"))).nexted, true);
    assert.equal(
      (await runIp(ipRestriction(policyFor({ is_service_account: 1, ip_policy: "custom", allowed_ips: "203.0.113.7" })), reqAt("198.51.100.1"))).nexted,
      false
    );
  });
});

describe("the queries the session and the policy are read from", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

  it("session state selects is_service_account, or the middleware would read undefined", () => {
    const repo = src("repository/user.js");
    const stmt = repo.slice(repo.indexOf("GET-SESSION-STATE"), repo.indexOf("GET-SESSION-STATE") + 400);
    assert.match(stmt, /u\.is_service_account/);
  });

  it("the IP policy query does not follow a service account to an employee's outlet", () => {
    const repo = src("repository/user.js");
    const stmt = repo.slice(repo.indexOf("GET-IP-POLICY"), repo.indexOf("GET-IP-POLICY") + 700);
    assert.match(stmt, /u\.is_service_account/);
    assert.match(stmt, /LEFT JOIN new_employee ne ON ne\.employee_id = u\.employee_id AND u\.is_service_account = 0/);
  });

  it("the login credential row carries the flag, so login resolves the same policy", () => {
    assert.match(src("repository/user.js"), /u\.is_service_account AS is_service_account/);
  });

  it("no path reuses is_system_account to mean 'integration'", () => {
    const touched = ["middlewares/auth.js", "utils/ip.js", "repository/user.js", "usecase/user.js"];
    for (const f of touched) {
      assert.ok(!/is_system_account['"`\s]*[:=]\s*1\s*;?\s*\/\/\s*service/i.test(src(f)), f);
    }
    // `employeeActive` excuses the two kinds separately, by name.
    const authSrc = src("middlewares/auth.js");
    assert.match(authSrc, /Number\(state\.is_system_account\) === 1\) return true;/);
    assert.match(authSrc, /Number\(state\.is_service_account\) === 1\) return true;/);
  });
});
