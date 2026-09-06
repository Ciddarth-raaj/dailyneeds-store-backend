/**
 * The auth middleware reads services/jwt's default instance, which reads
 * config/auth when first required. Point both at a throwaway keypair via
 * the environment BEFORE requiring anything from the app.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-jwt-"));
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

const reqFor = (token, p = "/ticket", method = "GET") => ({
  path: p,
  method,
  headers: token ? { "x-access-token": token } : {},
});

describe("auth middleware — identity shape (A3, C3)", () => {
  it("sets req.auth from sub and keeps req.decoded for existing handlers", async () => {
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1, designation_id: 4, store_id: 2 }, "1h", { subject: "7" });
    const { nexted, req } = await run(auth.create(), reqFor(token));
    assert.equal(nexted, true);
    assert.equal(req.auth.userId, 7);
    assert.equal(req.auth.employeeId, 1003);
    assert.equal(req.auth.isSystemAccount, false);
    assert.equal(req.decoded.id, 7);
    assert.equal(req.decoded.employee_id, 1003);
    assert.equal(req.decoded.store_id, 2);
  });

  it("44. a system-account token yields employee_id null, never undefined or a fake", async () => {
    const token = await jwtService.sign({ auth_ver: 2, id: 99, user_type: 2, sys: true }, "1h", { subject: "99" });
    const { req } = await run(auth.create(), reqFor(token));
    assert.equal(req.auth.userId, 99);
    assert.equal(req.auth.isSystemAccount, true);
    assert.strictEqual(req.auth.employeeId, null);
    assert.strictEqual(req.decoded.employee_id, null);
    assert.equal(req.decoded.is_system_account, true);
  });

  it("a pre-Stage-0A token without sub still authenticates via id during the overlap", async () => {
    const token = await jwtService.sign({ id: 7, employee_id: 1003, user_type: 1 }, "1h");
    const { nexted, req } = await run(auth.create(), reqFor(token));
    assert.equal(nexted, true);
    assert.equal(req.auth.userId, 7);
  });

  it("rejects a missing or garbage token", async () => {
    assert.equal((await run(auth.create(), reqFor(null))).res.body.code, 403);
    assert.equal((await run(auth.create(), reqFor("not.a.jwt"))).res.body.code, 403);
  });

  it("unprotected routes pass without a token and without req.auth", async () => {
    const { nexted, req } = await run(auth.create(), reqFor(null, "/user/login", "POST"));
    assert.equal(nexted, true);
    assert.equal(req.auth, undefined);
  });
});

describe("auth middleware — token_valid_from (C4)", () => {
  const stateFor = (validFrom, status = 1) => ({
    getSessionState: async () => ({ user_id: 7, employee_id: 1003, status, token_valid_from: validFrom, must_change_password: 0, is_system_account: 0 }),
  });
  const cfg = (over) => F.config({ login: { tokenValidFromEnabled: true, tokenValidFromCacheMs: 0 }, ...over });

  it("41. a token issued before token_valid_from is rejected", async () => {
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1 }, "1h", { subject: "7" });
    const mw = auth.create({ userUsecase: stateFor(new Date(Date.now() + 5000)), config: cfg() });
    const { nexted, res } = await run(mw, reqFor(token));
    assert.equal(nexted, false);
    assert.equal(res.body.error, "TOKEN_REVOKED");
  });

  it("42. a token issued after token_valid_from succeeds", async () => {
    const mw = auth.create({ userUsecase: stateFor(new Date(Date.now() - 5000)), config: cfg() });
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1 }, "1h", { subject: "7" });
    assert.equal((await run(mw, reqFor(token))).nexted, true);
  });

  it("a disabled account's token stops working", async () => {
    const mw = auth.create({ userUsecase: stateFor(null, 0), config: cfg() });
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1 }, "1h", { subject: "7" });
    assert.equal((await run(mw, reqFor(token))).nexted, false);
  });

  it("fails closed when the session check errors", async () => {
    const mw = auth.create({ userUsecase: { getSessionState: async () => { throw new Error("db down"); } }, config: cfg() });
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1 }, "1h", { subject: "7" });
    const { nexted, res } = await run(mw, reqFor(token));
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 500);
  });

  it("does nothing when the flag is off", async () => {
    const mw = auth.create({ userUsecase: stateFor(new Date(Date.now() + 5000)), config: F.config() });
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1 }, "1h", { subject: "7" });
    assert.equal((await run(mw, reqFor(token))).nexted, true);
  });
});

describe("auth middleware — must_change_password confinement (B2)", () => {
  it("confines a pwc token to the change-password routes when enforcement is on", async () => {
    const mw = auth.create({ config: F.config({ password: { enforcePasswordChange: true } }) });
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1, pwc: true }, "1h", { subject: "7" });
    const blocked = await run(mw, reqFor(token, "/ticket", "GET"));
    assert.equal(blocked.nexted, false);
    assert.equal(blocked.res.body.error, "PASSWORD_CHANGE_REQUIRED");
    assert.equal((await run(mw, reqFor(token, "/user/change-password", "POST"))).nexted, true);
    assert.equal((await run(mw, reqFor(token, "/user/logout", "POST"))).nexted, true);
  });

  it("does not confine when enforcement is off", async () => {
    const mw = auth.create({ config: F.config() });
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1, pwc: true }, "1h", { subject: "7" });
    assert.equal((await run(mw, reqFor(token, "/ticket", "GET"))).nexted, true);
  });
});

describe("43. existing designation/store permission behaviour still works", () => {
  it("permissions middleware reads designation_id and user_type from req.decoded as before", async () => {
    const permissions = require("./permissions")({
      getPermissionById: async (designationId) => (designationId === 4 ? [{ permission_key: "view_items" }] : []),
    });
    const token = await jwtService.sign({ auth_ver: 2, id: 7, employee_id: 1003, user_type: 1, designation_id: 4, store_id: 2 }, "1h", { subject: "7" });
    const { req } = await run(auth.create(), reqFor(token));
    assert.equal(await permissions.has(req, "view_items"), true);
    assert.equal(await permissions.has(req, "view_payroll"), false);

    const adminToken = await jwtService.sign({ auth_ver: 2, id: 99, user_type: 2, sys: true }, "1h", { subject: "99" });
    const admin = await run(auth.create(), reqFor(adminToken));
    assert.equal(await permissions.has(admin.req, "anything"), true, "user_type 2 still bypasses");
  });
});
