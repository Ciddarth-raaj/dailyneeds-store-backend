/**
 * Legacy / v2 JWT identity compatibility (safety correction pass, item 1;
 * regression category 14A).
 *
 * Production tokens before Stage 0A carried { id: user_id, employee_id, ... }
 * with no sub, no kid, no auth_ver. Stage 0A tokens carry auth_ver: 2 and
 * sub = user_id. The middleware must resolve each shape strictly by its own
 * rules and never let one be read as the other.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-jwt-compat-"));
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

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const jsonwebtoken = require("jsonwebtoken");
const F = require("../test_support/auth_fixtures");
const auth = require("./auth");

/** Exactly what the pre-Stage-0A usecase/user.js + services/jwt.js produced. */
const legacyToken = (payload) =>
  jsonwebtoken.sign(payload, privateKey, { expiresIn: "1d", algorithm: "RS256" });

/** What Stage 0A produces. */
const v2Token = (payload, sub) =>
  jsonwebtoken.sign({ auth_ver: 2, ...payload }, privateKey, {
    expiresIn: "1d",
    algorithm: "RS256",
    keyid: "legacy",
    subject: String(sub),
  });

const run = (mw, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(s) { this.statusCode = s; return this; },
      json(b) { this.body = b; return this; },
      end() { resolve({ nexted: false, res, req }); },
    };
    mw(req, res, () => resolve({ nexted: true, res, req }));
  });
const reqFor = (token) => ({ path: "/ticket", method: "GET", headers: { "x-access-token": token } });

/**
 * A directory where employee A's employee_id numerically equals user B's
 * user_id, and a break-glass account whose user_id equals another
 * employee's employee_id. This is the overlap the check exists for.
 */
const rows = {
  A: F.employeeRow({ user_id: 7, username: "A", employee_id: 42 }),
  B: F.employeeRow({ user_id: 42, username: "B", employee_id: 9001 }),
  breakglass: F.systemRow({ user_id: 9001, username: "breakglass" }),
};
const usecase = { getSessionState: (id) => F.fakeUserRepo(rows).getSessionState(id) };
const mw = () => auth.create({ userUsecase: usecase, config: F.config() });

describe("Section 1 — legacy / v2 identity resolution", () => {
  it("1. legacy token resolves using id (user_id) and employee_id, and is marked legacy", async () => {
    const t = legacyToken({ id: 7, employee_id: 42, user_type: 1, designation_id: 4, store_id: 2 });
    const { nexted, req } = await run(mw(), reqFor(t));
    assert.equal(nexted, true);
    assert.equal(req.auth.userId, 7);
    assert.equal(req.auth.employeeId, 42);
    assert.equal(req.auth.authVersion, 1);
    assert.equal(req.auth.isSystemAccount, false);
    assert.equal(req.decoded.employee_id, 42);
  });

  it("2. new auth_ver=2 token resolves using sub (user_id)", async () => {
    const t = v2Token({ id: 42, employee_id: 9001, user_type: 1 }, 42);
    const { nexted, req } = await run(mw(), reqFor(t));
    assert.equal(nexted, true);
    assert.equal(req.auth.userId, 42);
    assert.equal(req.auth.employeeId, 9001);
    assert.equal(req.auth.authVersion, 2);
  });

  it("3. overlapping user_id / employee_id values cannot cross-authenticate", async () => {
    // A's employee_id is 42; B's user_id is 42. A legacy token for A must be user 7, never user 42.
    const legacyA = legacyToken({ id: 7, employee_id: 42, user_type: 1 });
    const a = await run(mw(), reqFor(legacyA));
    assert.equal(a.req.auth.userId, 7);
    assert.notEqual(a.req.auth.userId, 42);
    // and a v2 token for B is user 42, never employee 42's account (user 7)
    const v2B = v2Token({ id: 42, employee_id: 9001, user_type: 1 }, 42);
    const b = await run(mw(), reqFor(v2B));
    assert.equal(b.req.auth.userId, 42);
    assert.equal(b.req.auth.employeeId, 9001);
  });

  it("4. legacy employee A cannot resolve to user B when B.user_id equals A.employee_id", async () => {
    // A forged/legacy token that tries to name user 42 via the employee namespace:
    // legacy resolution reads `id` only; `employee_id` is never used as an account key.
    const t = legacyToken({ id: 7, employee_id: 42, user_type: 1 });
    const { req } = await run(mw(), reqFor(t));
    assert.equal(req.auth.userId, 7);
    // and a legacy token whose id/employee_id disagree with the database is refused
    const mismatched = legacyToken({ id: 7, employee_id: 9001, user_type: 1 });
    const r = await run(mw(), reqFor(mismatched));
    assert.equal(r.nexted, false);
    assert.equal(r.res.body.code, 403);
  });

  it("5. break-glass v2 token resolves by user_id with employee_id NULL", async () => {
    const t = v2Token({ id: 9001, user_type: 2, sys: true }, 9001);
    const { nexted, req } = await run(mw(), reqFor(t));
    assert.equal(nexted, true);
    assert.equal(req.auth.userId, 9001);
    assert.equal(req.auth.isSystemAccount, true);
    assert.strictEqual(req.auth.employeeId, null);
  });

  it("6. unknown or malformed auth_ver is rejected safely", async () => {
    const bad = [
      { auth_ver: 1, id: 7, employee_id: 42, user_type: 1 },
      { auth_ver: 3, id: 7, employee_id: 42, user_type: 1 },
      { auth_ver: "2", id: 7, employee_id: 42, user_type: 1 },
      { auth_ver: null, id: 7, employee_id: 42, user_type: 1 },
      { auth_ver: { v: 2 }, id: 7, employee_id: 42, user_type: 1 },
      { auth_ver: 2, id: 7, employee_id: 42, user_type: 1 }, // v2 without sub
      { auth_ver: 2, id: 8, employee_id: 42, user_type: 1, sub: "7" }, // id disagrees with sub
    ];
    for (const payload of bad) {
      const { sub, ...rest } = payload;
      const t = jsonwebtoken.sign(rest, privateKey, { algorithm: "RS256", expiresIn: "1h", ...(sub ? { subject: sub } : {}) });
      const r = await run(mw(), reqFor(t));
      assert.equal(r.nexted, false, JSON.stringify(payload));
      assert.equal(r.res.body.code, 403);
    }
  });

  it("7. a legacy token can NEVER resolve to a system / break-glass account", async () => {
    // (a) a legacy-shaped token naming the system account's user_id: refused by the DB check
    const namesSystem = legacyToken({ id: 9001, employee_id: 42, user_type: 2 });
    const a = await run(mw(), reqFor(namesSystem));
    assert.equal(a.nexted, false);
    // (b) legacy shape with employee_id null / absent: refused before any lookup
    for (const p of [{ id: 9001, user_type: 2 }, { id: 9001, employee_id: null, user_type: 2 }]) {
      const r = await run(mw(), reqFor(legacyToken(p)));
      assert.equal(r.nexted, false, JSON.stringify(p));
    }
    // (c) legacy shape smuggling sys:true or a sub: refused as malformed
    for (const p of [{ id: 9001, employee_id: 42, user_type: 2, sys: true }, { id: 9001, employee_id: 42, user_type: 2, pwc: true }]) {
      const r = await run(mw(), reqFor(legacyToken(p)));
      assert.equal(r.nexted, false, JSON.stringify(p));
    }
    const withSub = jsonwebtoken.sign({ id: 9001, employee_id: 42, user_type: 2 }, privateKey, { algorithm: "RS256", expiresIn: "1h", subject: "9001" });
    assert.equal((await run(mw(), reqFor(withSub))).nexted, false);
    // (d) even without a usecase wired in, the shape rules alone refuse (b) and (c)
    const bare = auth.create({ config: F.config() });
    assert.equal((await run(bare, reqFor(legacyToken({ id: 9001, user_type: 2 })))).nexted, false);
    assert.equal((await run(bare, reqFor(legacyToken({ id: 9001, employee_id: 42, user_type: 2, sys: true })))).nexted, false);
  });

  it("a legacy token for a disabled or system-flagged row is refused by the database check", async () => {
    const disabled = { D: F.employeeRow({ user_id: 5, username: "D", employee_id: 55, status: 0 }) };
    const m = auth.create({ userUsecase: { getSessionState: (id) => F.fakeUserRepo(disabled).getSessionState(id) }, config: F.config() });
    assert.equal((await run(m, reqFor(legacyToken({ id: 5, employee_id: 55, user_type: 1 })))).nexted, false);
  });

  it("the legacy database check fails closed", async () => {
    const m = auth.create({ userUsecase: { getSessionState: async () => { throw new Error("db down"); } }, config: F.config() });
    const r = await run(m, reqFor(legacyToken({ id: 7, employee_id: 42, user_type: 1 })));
    assert.equal(r.nexted, false);
    assert.equal(r.res.statusCode, 500);
  });

  it("resolveIdentity is exported and pure for direct inspection", () => {
    const { resolveIdentity } = auth;
    assert.deepEqual(resolveIdentity({ id: 7, employee_id: 42 }), { userId: 7, employeeId: 42, isSystemAccount: false, legacy: true });
    assert.equal(resolveIdentity({ id: 7 }), null);
    assert.equal(resolveIdentity({ auth_ver: 2, sub: "abc" }), null);
    assert.equal(resolveIdentity({ auth_ver: 2, sub: "9001", sys: true, employee_id: 42 }), null, "a system token carrying an employee_id is malformed");
  });
});
