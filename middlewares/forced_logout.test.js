/**
 * Forced logout of every person (config.login.forcedLogoutAt).
 *
 *   node --test middlewares/forced_logout.test.js
 *
 * A token issued before the cut-off is refused with TOKEN_REVOKED, whoever
 * holds it - except a service account, whose installed token (the Tally
 * bridge) must keep working. A token issued after it is unaffected.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-forced-"));
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
        resolve({ nexted: false, res });
      },
    };
    mw(req, res, () => resolve({ nexted: true, res }));
  });

const reqFor = (token) => ({ path: "/employee/directory", method: "GET", headers: { "x-access-token": token } });

const session = ({ service = 0 } = {}) => ({
  getSessionState: async () => ({
    user_id: 198,
    employee_id: 1,
    status: 1,
    token_valid_from: null,
    must_change_password: 0,
    is_system_account: 0,
    is_service_account: service,
    employee_status: 1,
  }),
});

const now = () => Math.floor(Date.now() / 1000);
const cfg = (forcedLogoutAt) => {
  const c = F.config({ login: { tokenValidFromCacheMs: 0 } });
  c.login.forcedLogoutAt = forcedLogoutAt;
  return c;
};

const legacyToken = () => jwtService.sign({ id: 198, employee_id: 1, user_type: 1 }, "1h");
const modernToken = () => jwtService.sign({ auth_ver: 2, id: 198, employee_id: 1, user_type: 1 }, "1h", { subject: "198" });

describe("forced logout", () => {
  it("refuses a person's token issued before the cut-off, legacy and auth_ver 2 alike", async () => {
    const mw = auth.create({ userUsecase: session(), config: cfg(now() + 60) });
    for (const token of [await legacyToken(), await modernToken()]) {
      const { nexted, res } = await run(mw, reqFor(token));
      assert.equal(nexted, false);
      assert.equal(res.body.error, "TOKEN_REVOKED");
      assert.equal(res.body.msg, "Access Denied", "the frontend sends this message to /login");
    }
  });

  it("spares a service account, so the Tally bridge keeps working", async () => {
    const mw = auth.create({ userUsecase: session({ service: 1 }), config: cfg(now() + 60) });
    assert.equal((await run(mw, reqFor(await legacyToken()))).nexted, true);
    assert.equal((await run(mw, reqFor(await modernToken()))).nexted, true);
  });

  it("accepts a token issued after the cut-off - signing in again works", async () => {
    const mw = auth.create({ userUsecase: session(), config: cfg(now() - 60) });
    assert.equal((await run(mw, reqFor(await modernToken()))).nexted, true);
  });

  it("does nothing when unset", async () => {
    const mw = auth.create({ userUsecase: session(), config: cfg(0) });
    assert.equal((await run(mw, reqFor(await legacyToken()))).nexted, true);
  });

  it("the shipped default is in the past, never the future", () => {
    const shipped = require("../config/auth").login.forcedLogoutAt;
    assert.ok(shipped > 0 && shipped <= now(), "a future cut-off would refuse every new login");
  });
});
