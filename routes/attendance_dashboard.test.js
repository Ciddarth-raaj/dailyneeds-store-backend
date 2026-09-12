/**
 * The Attendance Dashboard API - AUTHORIZATION, over a real Express server.
 *
 *   node --test routes/attendance_dashboard.test.js
 *
 * These are the tests that matter most for a screen like this. The dashboard
 * aggregates the whole company's attendance, so the question "who may call
 * this" has to be answered by the SERVER on EVERY endpoint - not by the
 * navigation hiding a menu entry, and not once on the page with the data
 * endpoints left open behind it.
 *
 * So every route is exercised four ways: signed out, with an expired token,
 * signed in without the key, and signed in with it. The list of routes is
 * derived from the router itself, so a fifth endpoint added later without a
 * permission check FAILS THIS FILE rather than shipping unnoticed.
 *
 * A real `jwt` and the real `auth` and `permissions` middleware are used; only
 * the usecase is a stub, because what is under test is the gate and not the
 * counting.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-att-dash-"));
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

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const auth = require("../middlewares/auth");
const buildPermissions = require("../middlewares/permissions");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const { effectiveStoreIds } = require("./attendance_dashboard");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;

const HR_EXECUTIVE = 9; // holds the dashboard key
const HR_ASSISTANT = 10; // holds the per-employee screen but NOT the dashboard
const OUTLET_STAFF = 4; // holds nothing

const GRANTS = {
  [HR_EXECUTIVE]: [P.VIEW_ATTENDANCE_DASHBOARD, P.VIEW_CALCULATED_ATTENDANCE],
  [HR_ASSISTANT]: [P.VIEW_CALCULATED_ATTENDANCE],
  [OUTLET_STAFF]: [],
};

const DATE = "2026-09-12";

/** What the usecase was asked, so a scope test can inspect it. */
const seen = { overview: null, drilldown: null, trend: null, recent: null };

const usecase = {
  getFilters: async () => ({
    outlets: [
      { store_id: 1, outlet_name: "Main Store" },
      { store_id: 2, outlet_name: "Warehouse" },
    ],
    designations: [{ designation_id: 5, designation_name: "Cashier" }],
    shifts: [{ work_shift_id: 7, shift_code: "10-10", shift_name: "Shift 7" }],
    today: DATE,
  }),
  getOverview: async (args) => {
    seen.overview = args;
    return { attendance_date: args.attendance_date, cards: {}, overview: {}, by_location: [] };
  },
  getDrilldown: async (args) => {
    seen.drilldown = args;
    return { attendance_date: args.attendance_date, bucket: args.bucket, total: 0, employees: [] };
  },
  getTrend: async (args) => {
    seen.trend = args;
    return { days: [], available: false };
  },
  getRecentPunches: async (args) => {
    seen.recent = args;
    return { punches: [], devices: [] };
  },
};

const sessionState = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

let server;
let port;
let router;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });

  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionState } }));
  delete require.cache[require.resolve("./attendance_dashboard")];
  const routes = require("./attendance_dashboard")(usecase, permissions, null);
  router = routes.getRouter();
  app.use("/", router);

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ designationId = HR_EXECUTIVE, userType = 1, expiry = "1d" } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: EMPLOYEE_ID,
      user_type: userType,
      designation_id: designationId,
      store_id: 2,
    },
    expiry
  );

const call = async (p, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: token ? { "x-access-token": await token } : {},
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = { raw: text };
  }
  return { status: res.status, body };
};

/**
 * "This request was refused."
 *
 * THE REFUSAL CODE IS IN THE BODY, and that is this codebase's deliberate
 * convention rather than an accident: `middlewares/auth.js` `deny()` answers a
 * 403 as HTTP 200 with `{code: 403}`, because the frontend's `util/api.js`
 * relies on the body-level code to redirect to the login screen. The
 * permission middleware answers with a real HTTP 403 as well. So a test that
 * asserted only on the HTTP status would PASS on a wide-open endpoint that
 * happened to answer 200 with a refusal body - and would fail on a correctly
 * refused one. What actually matters is that the caller got a refusal and NOT
 * data, so both halves are asserted here.
 */
const assertRefused = (res, what) => {
  assert.ok(
    res.body && (res.body.code === 401 || res.body.code === 403),
    `${what}: expected a 401/403 refusal, got HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`
  );
  assert.notEqual(res.body.code, 200, `${what}: must not answer with data`);
};

/** Every GET path the router declares, with a usable query string. */
const ENDPOINTS = [
  `/attendance/dashboard/filters`,
  `/attendance/dashboard/overview?attendance_date=${DATE}`,
  `/attendance/dashboard/drilldown?attendance_date=${DATE}&bucket=CHECKED_IN`,
  `/attendance/dashboard/trend?attendance_date=${DATE}`,
  `/attendance/dashboard/recent-punches`,
];

describe("every endpoint fails closed", () => {
  ENDPOINTS.forEach((endpoint) => {
    const name = endpoint.split("?")[0];

    it(`${name} refuses an unauthenticated request`, async () => {
      const res = await call(endpoint, null);
      assertRefused(res, "signed out");
    });

    it(`${name} refuses an EXPIRED token`, async () => {
      const expired = await tokenFor({ expiry: "-1s" });
      const res = await call(endpoint, expired);
      assertRefused(res, "expired token");
    });

    it(`${name} refuses a signed-in caller WITHOUT the dashboard key`, async () => {
      const res = await call(endpoint, tokenFor({ designationId: OUTLET_STAFF }));
      assertRefused(res, "no dashboard key");
      assert.equal(res.status, 403, "no endpoint may answer without view_attendance_dashboard");
    });

    it(`${name} refuses a caller who holds only view_calculated_attendance`, async () => {
      const res = await call(endpoint, tokenFor({ designationId: HR_ASSISTANT }));
      assertRefused(res, "only view_calculated_attendance");
      assert.equal(res.status, 403, "the per-employee screen's key is not the aggregate's key");
    });

    it(`${name} answers a caller holding the key`, async () => {
      const res = await call(endpoint, tokenFor({ designationId: HR_EXECUTIVE }));
      assert.equal(res.status, 200);
      assert.equal(res.body.code, 200);
    });

    it(`${name} answers an administrator through the user_type bypass`, async () => {
      const res = await call(endpoint, tokenFor({ designationId: OUTLET_STAFF, userType: 2 }));
      assert.equal(res.status, 200);
    });
  });
});

describe("the router has no write path at all", () => {
  it("declares only GET routes", () => {
    const methods = router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods));
    assert.ok(methods.length > 0, "the router declares routes");
    assert.deepEqual(
      [...new Set(methods)],
      ["get"],
      "a read-only dashboard must not expose a POST, PUT, PATCH or DELETE"
    );
  });

  it("every declared route is covered by this file's authorization cases", () => {
    const declared = router.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path)
      .sort();
    const covered = [...new Set(ENDPOINTS.map((e) => e.split("?")[0]))].sort();
    assert.deepEqual(
      declared,
      covered,
      "a new endpoint was added without an authorization test - add it to ENDPOINTS"
    );
  });

  it("refuses a non-GET verb on a dashboard path", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/attendance/dashboard/overview`, {
      method: "POST",
      headers: {
        "x-access-token": await tokenFor({ designationId: HR_EXECUTIVE }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ attendance_date: DATE }),
    });
    assert.ok(res.status === 404 || res.status === 405, `expected no POST handler, got ${res.status}`);
  });
});

describe("the input is validated rather than trusted", () => {
  it("refuses a missing date", async () => {
    const res = await call("/attendance/dashboard/overview", tokenFor());
    assert.equal(res.body.code, 422);
  });

  it("refuses a malformed date", async () => {
    const res = await call(
      "/attendance/dashboard/overview?attendance_date=12-09-2026",
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("refuses an unknown query parameter rather than ignoring it", async () => {
    const res = await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&employee_id=9`,
      tokenFor()
    );
    assert.equal(res.body.code, 422, "Joi refuses unknown keys, so no smuggled parameter is silently dropped");
  });

  it("refuses an unknown drilldown bucket", async () => {
    const res = await call(
      `/attendance/dashboard/drilldown?attendance_date=${DATE}&bucket=EVERYTHING`,
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("refuses a drilldown page larger than the cap", async () => {
    const res = await call(
      `/attendance/dashboard/drilldown?attendance_date=${DATE}&bucket=TOTAL&limit=5000`,
      tokenFor()
    );
    assert.equal(res.body.code, 422, "lists are paginated, never unbounded");
  });

  it("refuses a trend window beyond a month", async () => {
    const res = await call(
      `/attendance/dashboard/trend?attendance_date=${DATE}&days=400`,
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("refuses a non-numeric outlet filter", async () => {
    const res = await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&store_ids=1;DROP`,
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("sets no-store on the aggregates, so a shared cache cannot serve them on", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/attendance/dashboard/overview?attendance_date=${DATE}`,
      { headers: { "x-access-token": await tokenFor() } }
    );
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("the browser's outlet filter is a FILTER, never authorization", () => {
  it("passes a requested outlet through as a filter when the scope is open", async () => {
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}&store_ids=2`, tokenFor());
    assert.deepEqual(seen.overview.store_ids, [2]);
  });

  it("no filter means no narrowing, not 'the caller's own store'", async () => {
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, tokenFor());
    assert.equal(
      seen.overview.store_ids,
      null,
      "today's scope is company-wide, exactly as the existing attendance screens are"
    );
  });

  it("INTERSECTS the request with the scope and can never widen it", () => {
    // The unit of the rule, independent of today's open scope: when a scope
    // exists, a request naming an outlet outside it gets the intersection.
    assert.deepEqual(effectiveStoreIds("1,2,3", [2, 3]), [2, 3]);
    assert.deepEqual(effectiveStoreIds("9", [2, 3]), [], "an out-of-scope outlet yields nothing");
    assert.deepEqual(effectiveStoreIds(null, [2, 3]), [2, 3], "no filter falls back to the scope");
    assert.deepEqual(effectiveStoreIds("", [2, 3]), [2, 3]);
    assert.deepEqual(effectiveStoreIds("2", null), [2], "an open scope leaves the filter as a filter");
    assert.equal(effectiveStoreIds(null, null), null);
  });

  it("the filter selector offers only outlets inside the scope", async () => {
    const res = await call("/attendance/dashboard/filters", tokenFor());
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.outlets.map((o) => o.store_id),
      [1, 2],
      "with today's open scope, every outlet; the filter is applied from resolveLocationScope"
    );
  });

  it("a search term reaches the usecase as a filter, trimmed", async () => {
    await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&search=%20Priya%20`,
      tokenFor()
    );
    assert.equal(seen.overview.search, "Priya");
  });

  it("the trend refuses a search parameter: it is an aggregate over days", async () => {
    const res = await call(
      `/attendance/dashboard/trend?attendance_date=${DATE}&search=Priya`,
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });
});
