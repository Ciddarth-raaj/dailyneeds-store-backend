/**
 * SERVER-SIDE PERMISSION ENFORCEMENT ON THE EXISTING GST ROUTES.
 *
 *   node --test routes/gst_permission_enforcement.test.js
 *
 * A REAL Express app with the REAL authentication middleware, the REAL
 * permission middleware and the REAL four GST routers, mounted at the REAL
 * paths. Only the database and the Sandbox provider are stood in for.
 *
 * ============================== THE DEFECT THIS FIXES =====================
 *
 * Six GST permission keys have existed since May 2026, every one of them
 * inserted into `all_permissions` and used by the frontend to hide menu
 * entries. NONE of them was checked by the server: `server.js` built the GST
 * router with no `permissions` argument, and so did the three purchase-GST
 * routers. Any signed-in user - a picker, a cashier, anyone with a login -
 * could read the vendor master, read the purchase register, write or delete a
 * GSTR-2A match, or trigger a live GSTR-2A pull against the GST portal.
 *
 * Hiding a button is presentation. This file is what actually stops a request.
 *
 * ============================== WHAT MUST STAY TRUE =======================
 *
 * A hardening change that breaks the screens it protects is not hardening, it
 * is an outage. Half of this file pins ACCESS THAT MUST SURVIVE:
 *
 *   - five screens share one backend through `GstModuleWrapper`, so the
 *     taxpayer session and OTP endpoints must answer to all five screens'
 *     keys, not just `view_gst_portal`;
 *   - `GET /purchase-gst` is read by BOTH the GSTR-2A Purchase Register and
 *     All Tally Purchases, which are different screens under different keys;
 *   - `GET /gst/vendors` and `GET /gst/fetch-log/latest` are read by BOTH the
 *     Vendors screen and Filing Dates.
 *
 * It also pins that the guards did not become a rubber stamp: a caller with
 * NO GST keys is refused everywhere, and holding one GST key does not confer
 * another.
 *
 * Response bodies and the 428 OTP contract are asserted unchanged.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-gst-perm-"));
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

/* --------------------------------------------------------- designations */

const D = {
  PORTAL: 1, // GST Portal only
  VENDORS: 2, // GST Vendors only
  FILING: 3, // Filing Dates only
  PR: 4, // GSTR-2A v Purchase Register only
  TALLY_VIEW: 5, // All Tally Purchases, read only
  TALLY_DELETE: 6, // All Tally Purchases, with delete
  SYNCER: 7, // may pull a return period from GSTN
  NOBODY: 8, // signed in, no GST rights at all - the picker/cashier
  ADMIN: 9, // user_type 2, holds everything implicitly
};

const GRANTS = {
  [D.PORTAL]: [P.VIEW_GST_PORTAL],
  [D.VENDORS]: [P.VIEW_GST_VENDORS],
  [D.FILING]: [P.VIEW_GST_FILING_DATES],
  [D.PR]: [P.VIEW_GST_GSTR2A_PURCHASE_REGISTER],
  [D.TALLY_VIEW]: [P.VIEW_TALLY_PURCHASES],
  [D.TALLY_DELETE]: [P.VIEW_TALLY_PURCHASES, P.DELETE_TALLY_PURCHASES],
  [D.SYNCER]: [P.VIEW_GST_FILING_DATES, P.SYNC_GST_GSTR2A_B2B],
  [D.NOBODY]: [],
  [D.ADMIN]: [],
};

/* ------------------------------------------------- the stub usecases    */

let calls;
const resetCalls = () => {
  calls = {
    sync: [],
    matchUpsert: [],
    matchDelete: [],
    no2aAccept: [],
    no2aDelete: [],
    gstDelete: [],
  };
};
resetCalls();

/** The 428 payload shape `services/gst_authentication.js` builds. */
const OTP_BLOCK = {
  code: 428,
  requires_gst_taxpayer_otp: true,
  msg: "GST taxpayer OTP is required before calling this API.",
  token_expires_at_ms: null,
  session_expires_at_ms: null,
  last_otp_verified_at_ms: null,
  revalidation_required_after_ms: null,
  needs_revalidation: true,
  session_expired: true,
};

const SESSION_PAYLOAD = {
  has_taxpayer_token: true,
  token_expires_at_ms: 1790000000000,
  session_expires_at_ms: 1792000000000,
  last_otp_verified_at_ms: 1789000000000,
  revalidation_required_after_ms: 1791500000000,
  needs_revalidation: false,
  session_expired: false,
};

const gstUsecase = {
  async getTaxpayerSessionStatus() {
    return { code: 200, session: SESSION_PAYLOAD };
  },
  async assertTaxpayerSessionForGstApis() {
    return null;
  },
  async requestTaxpayerOtp() {
    return {
      code: 200,
      axios_http_status: 200,
      sandbox: { code: 200 },
      session: SESSION_PAYLOAD,
    };
  },
  async verifyTaxpayerOtp() {
    return {
      code: 200,
      axios_http_status: 200,
      sandbox: { code: 200 },
      session: SESSION_PAYLOAD,
    };
  },
  async revalidateTaxpayerWithOtp() {
    return {
      code: 200,
      axios_http_status: 200,
      sandbox: { code: 200 },
      session: SESSION_PAYLOAD,
    };
  },
  async getAllVendorFilingDates() {
    return { code: 200, data: [] };
  },
  async getLatestFetchLog() {
    return { code: 200, data: null };
  },
  async getAllVendors() {
    return { code: 200, data: [] };
  },
  async getStoredB2bInvoicesForReturnPeriod() {
    return { code: 200, data: [], meta: {} };
  },
  async getStoredB2bInvoicesForReturnPeriodRange() {
    return { code: 200, data: [], meta: {} };
  },
  async getGstr2aB2bGroupedByVendors(year, month, createdBy) {
    calls.sync.push({ year, month, createdBy });
    return { code: 200, data: [] };
  },
  async searchGstin() {
    return { code: 200, data: {}, search_source: "database" };
  },
};

const purchaseGstUsecase = {
  async getAll() {
    return { code: 200, data: [] };
  },
  async getById() {
    return { code: 200, data: null };
  },
  async deleteTallyRow(id) {
    calls.gstDelete.push(id);
    return { code: 200, msg: "Deleted" };
  },
  async deleteTallyRows(ids) {
    calls.gstDelete.push(ids);
    return { code: 200, deleted: 0 };
  },
};

const gstPurchaseMatchUsecase = {
  async getAll() {
    return { code: 200, data: [] };
  },
  async upsert(row) {
    calls.matchUpsert.push(row);
    return { code: 200, gst_purchase_match_id: 1, updated: false };
  },
  async delete(id) {
    calls.matchDelete.push(id);
    return { code: 200, msg: "Deleted" };
  },
};

const gstPurchaseNo2aUsecase = {
  async getAll() {
    return { code: 200, data: [] };
  },
  async accept(body) {
    calls.no2aAccept.push(body);
    return { code: 200, accepted: 0 };
  },
  async remove(id) {
    calls.no2aDelete.push(id);
    return { code: 200, msg: "Deleted" };
  },
};

/* ------------------------------------------------------------- the app  */

let server, port;
/**
 * `utils/http#respondError` asks `global.isDev()` on the 500 path; server.js
 * defines it at boot and a test process has no boot. Without it a handler
 * that throws never answers, and the request hangs instead of failing.
 */
let hadIsDev;

before(async () => {
  hadIsDev = typeof global.isDev === "function";
  if (!hadIsDev) global.isDev = () => false;

  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({
        permission_key,
        is_active: 1,
      })),
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

  // Express routers in this codebase are module-level singletons, so a router
  // built by an earlier test file would already carry its own middleware.
  for (const m of [
    "../routes/gst",
    "../routes/purchase_gst",
    "../routes/purchase_gst_match",
    "../routes/purchase_gst_no_2a",
  ]) {
    delete require.cache[require.resolve(m)];
  }

  // THE REAL MOUNT PATHS, as server.js uses them.
  app.use(
    "/gst",
    require("../routes/gst")(gstUsecase, permissions).getRouter(),
  );
  app.use(
    "/purchase-gst",
    require("../routes/purchase_gst")(
      purchaseGstUsecase,
      permissions,
    ).getRouter(),
  );
  app.use(
    "/purchase-gst-match",
    require("../routes/purchase_gst_match")(
      gstPurchaseMatchUsecase,
      permissions,
    ).getRouter(),
  );
  app.use(
    "/purchase-gst-no-2a",
    require("../routes/purchase_gst_no_2a")(
      gstPurchaseNo2aUsecase,
      permissions,
    ).getRouter(),
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

const tokenFor = (employeeId, designationId, userType = 1) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(employeeId),
      id: employeeId,
      employee_id: employeeId,
      user_type: userType,
      designation_id: designationId,
      store_id: 1,
    },
    "1d",
  );

const AS = {
  portal: () => tokenFor(201, D.PORTAL),
  vendors: () => tokenFor(202, D.VENDORS),
  filing: () => tokenFor(203, D.FILING),
  pr: () => tokenFor(204, D.PR),
  tallyView: () => tokenFor(205, D.TALLY_VIEW),
  tallyDelete: () => tokenFor(206, D.TALLY_DELETE),
  syncer: () => tokenFor(207, D.SYNCER),
  nobody: () => tokenFor(208, D.NOBODY),
  admin: () => tokenFor(209, D.ADMIN, 2),
};

const call = async (method, url, token, body) => {
  // An explicit timeout, so a route that never answers fails THIS assertion
  // with its own name instead of stalling the whole file.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      signal: ac.signal,
      headers: {
        ...(token ? { "x-access-token": await token } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${method} ${url} did not answer within 10s (${err.name})`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }
  return { status: res.status, body: json, text };
};

const allowed = (res, what) =>
  assert.ok(
    res.status !== 403 && !(res.body && res.body.code === 403),
    `${what}: expected to be ALLOWED through the guard, got ${res.status} ${res.text.slice(0, 200)}`,
  );
const refused = (res, what) =>
  assert.ok(
    res.status === 403 && res.body && res.body.code === 403,
    `${what}: expected 403, got ${res.status} ${res.text.slice(0, 200)}`,
  );

/**
 * Every endpoint the four routers expose, with the callers that must get
 * through and a caller that must not. `allow` is the full set of designations
 * entitled to the endpoint; every other designation is asserted refused, so
 * adding a key to a route without updating this table fails the suite.
 */
const ENDPOINTS = [
  // ---- taxpayer session + OTP: every GST-module screen (GstModuleWrapper)
  {
    m: "GET",
    u: "/gst/taxpayer/session",
    allow: [
      "portal",
      "vendors",
      "filing",
      "pr",
      "tallyView",
      "tallyDelete",
      "syncer",
    ],
  },
  {
    m: "GET",
    u: "/gst/taxpayer/session/check",
    allow: [
      "portal",
      "vendors",
      "filing",
      "pr",
      "tallyView",
      "tallyDelete",
      "syncer",
    ],
  },
  {
    m: "POST",
    u: "/gst/taxpayer/otp/request",
    allow: [
      "portal",
      "vendors",
      "filing",
      "pr",
      "tallyView",
      "tallyDelete",
      "syncer",
    ],
  },
  {
    m: "POST",
    u: "/gst/taxpayer/otp/verify",
    body: { otp: "123456" },
    allow: [
      "portal",
      "vendors",
      "filing",
      "pr",
      "tallyView",
      "tallyDelete",
      "syncer",
    ],
  },
  {
    m: "POST",
    u: "/gst/taxpayer/revalidate",
    body: { otp: "123456" },
    allow: [
      "portal",
      "vendors",
      "filing",
      "pr",
      "tallyView",
      "tallyDelete",
      "syncer",
    ],
  },

  // ---- vendor master: Vendors screen AND Filing Dates
  { m: "GET", u: "/gst/vendors", allow: ["vendors", "filing", "syncer"] },
  {
    m: "POST",
    u: "/gst/search",
    // Synthetic and valid-shaped; never a real registration.
    body: { gstin: "29ABCDE1234F1Z5" },
    allow: ["vendors"],
  },

  // ---- filing dates: one screen, one key
  { m: "GET", u: "/gst/vendor-filing-dates", allow: ["filing", "syncer"] },

  // ---- fetch log: Purchase Register AND Filing Dates
  { m: "GET", u: "/gst/fetch-log/latest", allow: ["pr", "filing", "syncer"] },

  // ---- stored 2A reads: Purchase Register only
  {
    m: "GET",
    u: "/gst/b2b/invoices?from_period=2026-04&to_period=2026-04",
    allow: ["pr"],
  },
  { m: "GET", u: "/gst/b2b/invoices/2026/04", allow: ["pr"] },

  // ---- the live GSTN pull: its own key, deliberately not the view key
  { m: "GET", u: "/gst/gstr-2a/b2b/2026/04", allow: ["syncer"] },

  // ---- purchase snapshot reads: Purchase Register AND All Tally Purchases
  { m: "GET", u: "/purchase-gst", allow: ["pr", "tallyView", "tallyDelete"] },
  { m: "GET", u: "/purchase-gst/1", allow: ["pr", "tallyView", "tallyDelete"] },

  // ---- purchase snapshot deletes: the delete key the frontend already gates on
  {
    m: "POST",
    u: "/purchase-gst/bulk-delete",
    body: { gst_tally_purchase_ids: [1] },
    allow: ["tallyDelete"],
  },
  { m: "DELETE", u: "/purchase-gst/1", allow: ["tallyDelete"] },

  // ---- 2A matching: read and write both on the purchase-register key
  { m: "GET", u: "/purchase-gst-match?year=2026&month=4", allow: ["pr"] },
  {
    m: "POST",
    u: "/purchase-gst-match",
    body: { gst_b2b_invoice_id: 1, gst_tally_purchase_id: 1, matched_by: 1 },
    allow: ["pr"],
  },
  { m: "DELETE", u: "/purchase-gst-match/1", allow: ["pr"] },

  // ---- no-2A acceptance
  { m: "GET", u: "/purchase-gst-no-2a", allow: ["pr"] },
  {
    m: "POST",
    u: "/purchase-gst-no-2a",
    body: { gst_tally_purchase_ids: [1], accepted_by: 1 },
    allow: ["pr"],
  },
  { m: "DELETE", u: "/purchase-gst-no-2a/1", allow: ["pr"] },
];

const ALL_CALLERS = [
  "portal",
  "vendors",
  "filing",
  "pr",
  "tallyView",
  "tallyDelete",
  "syncer",
];

/* ------------------------------------------------------------- the tests */

describe("GST routes: every endpoint refuses a caller without its key", () => {
  it("a signed-in user with NO GST permissions is refused everywhere", async () => {
    for (const e of ENDPOINTS) {
      const res = await call(e.m, e.u, AS.nobody(), e.body);
      refused(res, `${e.m} ${e.u} as a caller with no GST keys`);
    }
  });

  it("holding one GST key does not confer another", async () => {
    for (const e of ENDPOINTS) {
      for (const who of ALL_CALLERS) {
        if (e.allow.includes(who)) continue;
        const res = await call(e.m, e.u, AS[who](), e.body);
        refused(res, `${e.m} ${e.u} as ${who}`);
      }
    }
  });

  it("no side effect runs when a caller is refused", async () => {
    resetCalls();
    await call("GET", "/gst/gstr-2a/b2b/2026/04", AS.nobody());
    await call("POST", "/purchase-gst-match", AS.nobody(), {
      gst_b2b_invoice_id: 1,
      gst_tally_purchase_id: 1,
      matched_by: 1,
    });
    await call("DELETE", "/purchase-gst-match/1", AS.nobody());
    await call("DELETE", "/purchase-gst/1", AS.nobody());
    await call("POST", "/purchase-gst-no-2a", AS.nobody(), {
      gst_tally_purchase_ids: [1],
      accepted_by: 1,
    });
    await call("DELETE", "/purchase-gst-no-2a/1", AS.nobody());
    assert.deepEqual(
      calls.sync,
      [],
      "a refused sync must not reach the GST portal",
    );
    assert.deepEqual(
      calls.matchUpsert,
      [],
      "a refused match write must not reach the usecase",
    );
    assert.deepEqual(calls.matchDelete, []);
    assert.deepEqual(calls.gstDelete, []);
    assert.deepEqual(calls.no2aAccept, []);
    assert.deepEqual(calls.no2aDelete, []);
  });

  it("an unauthenticated request never reaches a handler", async () => {
    // `middlewares/auth` answers a missing token with HTTP 200 and a 403 body
    // (`{code:403,msg:"Access Denied"}`). That predates this change and is not
    // altered by it; what matters here is that no handler runs.
    for (const e of ENDPOINTS) {
      const res = await call(e.m, e.u, null, e.body);
      const denied =
        res.status === 401 ||
        res.status === 403 ||
        (res.body && (res.body.code === 401 || res.body.code === 403));
      assert.ok(
        denied,
        `${e.m} ${e.u} unauthenticated: expected a denial, got ${res.status} ${res.text.slice(0, 120)}`,
      );
    }
  });
});

describe("GST routes: the entitled caller still gets through", () => {
  it("every endpoint admits each designation that is entitled to it", async () => {
    for (const e of ENDPOINTS) {
      for (const who of e.allow) {
        const res = await call(e.m, e.u, AS[who](), e.body);
        allowed(res, `${e.m} ${e.u} as ${who}`);
      }
    }
  });

  it("admin (user_type 2) bypasses every guard", async () => {
    for (const e of ENDPOINTS) {
      const res = await call(e.m, e.u, AS.admin(), e.body);
      allowed(res, `${e.m} ${e.u} as admin`);
    }
  });
});

describe("ACCESS THAT MUST SURVIVE: five screens share one backend", () => {
  it("GstModuleWrapper's session check works on every screen that mounts it", async () => {
    // Vendors, Filing Dates, Purchase Register and All Tally Purchases all
    // wrap in GstModuleWrapper. If this 403s, the screen does not render.
    for (const who of ["vendors", "filing", "pr", "tallyView"]) {
      allowed(
        await call("GET", "/gst/taxpayer/session/check", AS[who]()),
        `session check as ${who} (GstModuleWrapper would 403 the whole screen)`,
      );
    }
  });

  it("the OTP modal opened from any GST screen can request and verify", async () => {
    for (const who of ["vendors", "filing", "pr", "tallyView"]) {
      allowed(
        await call("POST", "/gst/taxpayer/otp/request", AS[who]()),
        `otp request as ${who}`,
      );
      allowed(
        await call("POST", "/gst/taxpayer/otp/verify", AS[who](), {
          otp: "123456",
        }),
        `otp verify as ${who}`,
      );
    }
  });

  it("All Tally Purchases can still read the purchase snapshot", async () => {
    // Gated on view_tally_purchases, NOT on the purchase-register key.
    allowed(
      await call("GET", "/purchase-gst", AS.tallyView()),
      "GET /purchase-gst as tallyView",
    );
  });

  it("Filing Dates can still read the vendor master and the fetch log", async () => {
    allowed(
      await call("GET", "/gst/vendors", AS.filing()),
      "GET /gst/vendors as filing",
    );
    allowed(
      await call("GET", "/gst/fetch-log/latest", AS.filing()),
      "GET /gst/fetch-log/latest as filing",
    );
  });

  it("the Purchase Register reads everything its screen needs", async () => {
    for (const u of [
      "/gst/b2b/invoices?from_period=2026-04&to_period=2026-04",
      "/purchase-gst",
      "/purchase-gst-match?year=2026&month=4",
      "/purchase-gst-no-2a",
      "/gst/fetch-log/latest",
    ]) {
      allowed(await call("GET", u, AS.pr()), `GET ${u} as pr`);
    }
  });
});

describe("the GSTR-2A pull is gated on its own key", () => {
  it("the purchase-register view key alone cannot pull from GSTN", async () => {
    refused(
      await call("GET", "/gst/gstr-2a/b2b/2026/04", AS.pr()),
      "a viewer must not be able to trigger a live GST portal pull",
    );
  });

  it("sync_gst_gstr2a_b2b pulls, and reaches the usecase", async () => {
    resetCalls();
    const res = await call("GET", "/gst/gstr-2a/b2b/2026/04", AS.syncer());
    allowed(res, "sync as syncer");
    assert.equal(
      calls.sync.length,
      1,
      "the sync must reach the usecase exactly once",
    );
    assert.equal(
      calls.sync[0].createdBy,
      207,
      "req.decoded.id must still be threaded through",
    );
  });
});

describe("behaviour the guards must not change", () => {
  it("the session payload is returned unchanged", async () => {
    const res = await call("GET", "/gst/taxpayer/session", AS.portal());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { code: 200, session: SESSION_PAYLOAD });
  });

  it("the OTP request/verify/revalidate payloads are returned unchanged", async () => {
    for (const [m, u, b] of [
      ["POST", "/gst/taxpayer/otp/request", undefined],
      ["POST", "/gst/taxpayer/otp/verify", { otp: "123456" }],
      ["POST", "/gst/taxpayer/revalidate", { otp: "123456" }],
    ]) {
      const res = await call(m, u, AS.portal(), b);
      assert.equal(res.status, 200, `${u} status`);
      assert.deepEqual(
        res.body.session,
        SESSION_PAYLOAD,
        `${u} session payload`,
      );
      assert.equal(res.body.code, 200, `${u} code`);
    }
  });

  it("OTP body validation still runs, and still runs AFTER the guard", async () => {
    // A bad body from an entitled caller is still a validation error...
    const bad = await call("POST", "/gst/taxpayer/otp/verify", AS.portal(), {
      otp: "nope",
    });
    assert.notEqual(bad.status, 200, "an invalid OTP body must not succeed");
    assert.notEqual(
      bad.status,
      403,
      "an entitled caller must not be refused by the guard",
    );
    // ...but an unentitled caller is refused before validation is reached.
    const refusedRes = await call(
      "POST",
      "/gst/taxpayer/otp/verify",
      AS.nobody(),
      { otp: "nope" },
    );
    refused(refusedRes, "guard must run before body validation");
  });

  it("the 428 requires-OTP contract is preserved for an entitled caller", async () => {
    const original = gstUsecase.assertTaxpayerSessionForGstApis;
    gstUsecase.assertTaxpayerSessionForGstApis = async () => OTP_BLOCK;
    try {
      const res = await call("GET", "/gst/taxpayer/session/check", AS.pr());
      assert.equal(
        res.status,
        428,
        "an entitled caller with no session still gets 428",
      );
      assert.equal(res.body.requires_gst_taxpayer_otp, true);
    } finally {
      gstUsecase.assertTaxpayerSessionForGstApis = original;
    }
  });

  it("422 validation on the match routes is unchanged for an entitled caller", async () => {
    const res = await call("POST", "/purchase-gst-match", AS.pr(), {
      nonsense: true,
    });
    assert.equal(
      res.status,
      422,
      "Joi validation must still produce 422, not 403",
    );
  });

  it("a match write by an entitled caller still reaches the usecase", async () => {
    resetCalls();
    const body = {
      gst_b2b_invoice_id: 7,
      gst_tally_purchase_id: 9,
      matched_by: 204,
    };
    const res = await call("POST", "/purchase-gst-match", AS.pr(), body);
    allowed(res, "match upsert as pr");
    assert.equal(calls.matchUpsert.length, 1);
    assert.equal(calls.matchUpsert[0].gst_b2b_invoice_id, 7);
  });
});

describe("no GST route is mounted without a permission guard", () => {
  /**
   * The guard against the next unguarded route. It walks the real Express
   * router stacks and fails if any layer's handler chain is just the handler.
   */
  const routerFor = (mod, usecase, permissions) => {
    delete require.cache[require.resolve(mod)];
    return require(mod)(usecase, permissions).getRouter();
  };

  it("every layer in all four routers carries middleware before its handler", () => {
    const permissions = buildPermissions({
      getPermissionById: async (designationId) =>
        (GRANTS[designationId] || []).map((permission_key) => ({
          permission_key,
          is_active: 1,
        })),
    });

    const routers = [
      ["/gst", routerFor("../routes/gst", gstUsecase, permissions)],
      [
        "/purchase-gst",
        routerFor("../routes/purchase_gst", purchaseGstUsecase, permissions),
      ],
      [
        "/purchase-gst-match",
        routerFor(
          "../routes/purchase_gst_match",
          gstPurchaseMatchUsecase,
          permissions,
        ),
      ],
      [
        "/purchase-gst-no-2a",
        routerFor(
          "../routes/purchase_gst_no_2a",
          gstPurchaseNo2aUsecase,
          permissions,
        ),
      ],
    ];

    const unguarded = [];
    let checked = 0;
    for (const [mount, router] of routers) {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        const methods = Object.keys(layer.route.methods)
          .join(",")
          .toUpperCase();
        // route.stack holds the handler chain: [guard, handler] once guarded,
        // [handler] while unguarded.
        if (layer.route.stack.length < 2) {
          unguarded.push(`${methods} ${mount}${layer.route.path}`);
        }
        checked += 1;
      }
    }

    assert.ok(
      checked >= 22,
      `expected to inspect every GST route, saw only ${checked}`,
    );
    assert.deepEqual(
      unguarded,
      [],
      `these GST routes have no permission guard: ${unguarded.join(", ")}`,
    );
  });

  it("the endpoint table above covers every route the routers expose", () => {
    const permissions = buildPermissions({ getPermissionById: async () => [] });
    const routers = [
      ["/gst", routerFor("../routes/gst", gstUsecase, permissions)],
      [
        "/purchase-gst",
        routerFor("../routes/purchase_gst", purchaseGstUsecase, permissions),
      ],
      [
        "/purchase-gst-match",
        routerFor(
          "../routes/purchase_gst_match",
          gstPurchaseMatchUsecase,
          permissions,
        ),
      ],
      [
        "/purchase-gst-no-2a",
        routerFor(
          "../routes/purchase_gst_no_2a",
          gstPurchaseNo2aUsecase,
          permissions,
        ),
      ],
    ];

    const real = [];
    for (const [mount, router] of routers) {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        for (const m of Object.keys(layer.route.methods)) {
          real.push(`${m.toUpperCase()} ${mount}${layer.route.path}`);
        }
      }
    }

    // Normalise the table's URLs back to route paths.
    const covered = new Set(
      ENDPOINTS.map((e) => {
        const p = e.u.split("?")[0];
        const asRoute = p
          .replace(
            /^\/gst\/b2b\/invoices\/\d+\/\d+$/,
            "/gst/b2b/invoices/:year/:month",
          )
          .replace(
            /^\/gst\/gstr-2a\/b2b\/\d+\/\d+$/,
            "/gst/gstr-2a/b2b/:year/:month",
          )
          .replace(
            /^\/purchase-gst-no-2a\/\d+$/,
            "/purchase-gst-no-2a/:gstTallyPurchaseId",
          )
          .replace(/^\/purchase-gst-match\/\d+$/, "/purchase-gst-match/:id")
          .replace(/^\/purchase-gst\/\d+$/, "/purchase-gst/:id");
        return `${e.m} ${asRoute}`;
      }),
    );

    const missing = real.filter((r) => {
      const normalised = r
        .replace("/purchase-gst/", "/purchase-gst/")
        .replace(
          / \/(purchase-gst|purchase-gst-match|purchase-gst-no-2a)\/$/,
          " /$1",
        );
      return !covered.has(normalised) && !covered.has(r);
    });

    assert.deepEqual(
      missing,
      [],
      `routes with no coverage in ENDPOINTS: ${missing.join(", ")}`,
    );
  });
});
