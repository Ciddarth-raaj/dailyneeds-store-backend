/**
 * PHASE 1A / FIX 3: A CONFIGURATION FAILURE MUST BE HTTP 503 ON THE WIRE.
 *
 *   node --test routes/gst_registration_http_status.test.js
 *
 * ============================== THE DEFECT ================================
 *
 * `usecase/gst.js` returns `{ code: 503, gst_registration_configured: false }`
 * when no GST registration is configured. The three OTP routes chose their
 * HTTP status as
 *
 *     payload.axios_http_status != null ? payload.axios_http_status : 502
 *
 * and a configuration refusal has no `axios_http_status`, because nothing was
 * ever sent to Sandbox. So the body said 503 and the wire said 502: a client
 * routing on HTTP status saw "bad gateway, retry" for a problem no retry can
 * fix.
 *
 * ============================== WHAT MUST STAY TRUE =======================
 *
 * The provider's own status still wins. A Sandbox 422 must remain a 422, and
 * the 502 fallback must survive for a payload that carries neither an
 * `axios_http_status` nor a legitimate HTTP `code` - which is what it was
 * there for.
 *
 * Bodies are asserted byte-for-byte unchanged: this fixes the status line,
 * nothing else.
 *
 * No real GSTIN or portal username appears here.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-gst-http-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({
  legacy: path.join(dir, "pub.key"),
});
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");

const auth = require("../middlewares/auth");
const buildPermissions = require("../middlewares/permissions");
const jwtService = require("../services/jwt");
const P = require("../constants/gst_permissions");
const { NOT_CONFIGURED_MSG } = require("../services/gst_authentication");

/** The exact body `usecase/gst.js` produces with no registration. */
const NOT_CONFIGURED_BODY = {
  code: 503,
  gst_registration_configured: false,
  msg: NOT_CONFIGURED_MSG,
};

/** Swapped per test to drive the route from every payload shape. */
let payload;

const gstUsecase = {
  async requestTaxpayerOtp() {
    return payload;
  },
  async verifyTaxpayerOtp() {
    return payload;
  },
  async revalidateTaxpayerWithOtp() {
    return payload;
  },
  async assertTaxpayerSessionForGstApis() {
    return payload && payload.__block ? payload.__block : null;
  },
  async getTaxpayerSessionStatus() {
    return payload && payload.__status
      ? payload.__status
      : { code: 200, session: { has_taxpayer_token: false } };
  },
};

let server, port, hadIsDev;

before(async () => {
  hadIsDev = typeof global.isDev === "function";
  if (!hadIsDev) global.isDev = () => false;

  const permissions = buildPermissions({
    getPermissionById: async () => [
      { permission_key: P.VIEW_GST_PORTAL, is_active: 1 },
    ],
  });

  const app = express();
  app.use(bodyParser.json());
  app.use(
    auth.create({
      userUsecase: {
        getSessionState: async (userId) => ({
          user_id: userId,
          employee_id: userId,
          status: 1,
          token_valid_from: null,
          is_system_account: 0,
          employee_status: 1,
        }),
      },
    }),
  );

  delete require.cache[require.resolve("../routes/gst")];
  app.use(
    "/gst",
    require("../routes/gst")(gstUsecase, permissions).getRouter(),
  );

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => {
  if (server) server.close();
  if (!hadIsDev) delete global.isDev;
});

const token = () =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: "900",
      id: 900,
      employee_id: 900,
      user_type: 1,
      designation_id: 1,
      store_id: 1,
    },
    "1d",
  );

const call = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      "x-access-token": await token(),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
};

const OTP_ENDPOINTS = [
  ["POST", "/gst/taxpayer/otp/request", undefined],
  ["POST", "/gst/taxpayer/otp/verify", { otp: "123456" }],
  ["POST", "/gst/taxpayer/revalidate", { otp: "123456" }],
];

/* ============================================================== the tests */

describe("missing GST registration is HTTP 503 on every OTP endpoint", () => {
  for (const [m, u, b] of OTP_ENDPOINTS) {
    it(`${m} ${u} -> 503`, async () => {
      payload = { ...NOT_CONFIGURED_BODY };
      const res = await call(m, u, b);
      assert.equal(res.status, 503, "the status line must say 503, not 502");
      assert.equal(res.body.code, 503);
      assert.equal(res.body.gst_registration_configured, false);
    });
  }

  it("the body is unchanged - only the status line was wrong", async () => {
    payload = { ...NOT_CONFIGURED_BODY };
    const res = await call("POST", "/gst/taxpayer/otp/request");
    assert.deepEqual(res.body, NOT_CONFIGURED_BODY);
  });

  it("/taxpayer/session/check also answers 503 for the same condition", async () => {
    payload = { __block: { ...NOT_CONFIGURED_BODY } };
    const res = await call("GET", "/gst/taxpayer/session/check");
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 503);
    assert.equal(res.body.gst_registration_configured, false);
  });
});

describe("the provider's own status still wins", () => {
  for (const [m, u, b] of OTP_ENDPOINTS) {
    it(`${m} ${u} preserves a Sandbox 422`, async () => {
      payload = { code: 422, axios_http_status: 422, sandbox: { code: 422 } };
      const res = await call(m, u, b);
      assert.equal(res.status, 422);
      assert.equal(res.body.code, 422);
    });
  }

  it("a Sandbox 200 stays 200 even when the body carries another code", async () => {
    payload = { code: 428, axios_http_status: 200, sandbox: { code: 428 } };
    const res = await call("POST", "/gst/taxpayer/otp/request");
    assert.equal(res.status, 200, "axios_http_status must win when present");
    assert.equal(res.body.code, 428);
  });

  it("a successful OTP request is still 200", async () => {
    payload = {
      code: 200,
      axios_http_status: 200,
      sandbox: { code: 200 },
      session: { has_taxpayer_token: true },
    };
    const res = await call("POST", "/gst/taxpayer/otp/request");
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 200);
  });
});

describe("the 502 fallback survives for everything else", () => {
  it("no axios_http_status and no HTTP-shaped code -> 502", async () => {
    payload = { code: 200, sandbox: { note: "transport failure" } };
    const res = await call("POST", "/gst/taxpayer/otp/request");
    assert.equal(res.status, 502, "200 is not an error code to surface here");
  });

  it("a non-numeric code -> 502", async () => {
    payload = { code: "oops" };
    const res = await call("POST", "/gst/taxpayer/otp/request");
    assert.equal(res.status, 502);
  });

  it("an out-of-range code -> 502", async () => {
    payload = { code: 99 };
    const res = await call("POST", "/gst/taxpayer/otp/request");
    assert.equal(res.status, 502);
  });

  it("a legitimate 4xx in the body is honoured", async () => {
    payload = { code: 429, msg: "rate limited upstream" };
    const res = await call("POST", "/gst/taxpayer/otp/request");
    assert.equal(res.status, 429);
  });
});

/**
 * GET /gst/taxpayer/session is read by the GST Portal screen directly. With no
 * registration configured it used to answer HTTP 200 describing the stored
 * session - "active", with a comfortable expiry - while every taxpayer
 * operation beside it refused. The screen said working, the system said no.
 */
describe("GET /gst/taxpayer/session reflects configuration state", () => {
  it("configured: unchanged HTTP 200 with the session payload", async () => {
    const session = {
      has_taxpayer_token: true,
      token_expires_at_ms: 1790000000000,
      session_expires_at_ms: 1792000000000,
      last_otp_verified_at_ms: 1789000000000,
      revalidation_required_after_ms: 1791500000000,
      needs_revalidation: false,
      session_expired: false,
    };
    payload = { __status: { code: 200, session } };
    const res = await call("GET", "/gst/taxpayer/session");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { code: 200, session });
  });

  it("NOT configured: HTTP 503 with session null", async () => {
    payload = { __status: { ...NOT_CONFIGURED_BODY, session: null } };
    const res = await call("GET", "/gst/taxpayer/session");
    assert.equal(res.status, 503, "the status line must say 503");
    assert.equal(res.body.code, 503);
    assert.equal(res.body.gst_registration_configured, false);
    assert.equal(res.body.session, null);
  });

  it("no stale session timings are exposed when unconfigured", async () => {
    payload = { __status: { ...NOT_CONFIGURED_BODY, session: null } };
    const res = await call("GET", "/gst/taxpayer/session");
    const body = JSON.stringify(res.body);
    for (const leak of [
      "has_taxpayer_token",
      "token_expires_at_ms",
      "session_expires_at_ms",
      "last_otp_verified_at_ms",
    ]) {
      assert.ok(!body.includes(leak), `${leak} must not be reported`);
    }
  });

  it("the message names variables, never a GSTIN or username", async () => {
    payload = { __status: { ...NOT_CONFIGURED_BODY, session: null } };
    const res = await call("GET", "/gst/taxpayer/session");
    assert.match(res.body.msg, /GST_OWN_GSTIN/);
    assert.match(res.body.msg, /GST_PORTAL_USERNAME/);
    assert.equal(
      res.body.msg.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/),
      null,
      "no GSTIN-shaped value in the message",
    );
  });
});
