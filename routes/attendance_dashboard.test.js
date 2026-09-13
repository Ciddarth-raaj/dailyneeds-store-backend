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
const { effectiveStoreIds, resolveLocationScope, SCOPE } = require("./attendance_dashboard");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;

/**
 * The designations these tests need, and what each proves.
 *
 *   HR_ALL_STORES   the dashboard key AND the existing `all_stores` grant.
 *                   The only non-administrator who resolves to a scope today.
 *   HR_EXECUTIVE    the dashboard key alone. Permitted to USE the screen, but
 *                   with no location authorization - so every endpoint refuses.
 *                   This is the fail-closed case the review asked for, and the
 *                   case the old `return null` silently turned into
 *                   company-wide access.
 *   HR_ASSISTANT    the per-employee attendance key only. Refused at the
 *                   permission gate, before scope is even considered.
 *   OUTLET_STAFF    nothing at all.
 */
const HR_ALL_STORES = 8;
const HR_EXECUTIVE = 9;
const HR_ASSISTANT = 10;
const OUTLET_STAFF = 4;

const ACCESS_ALL_STORES = "all_stores";

const GRANTS = {
  [HR_ALL_STORES]: [P.VIEW_ATTENDANCE_DASHBOARD, P.VIEW_CALCULATED_ATTENDANCE, ACCESS_ALL_STORES],
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

/** The operational snapshot usecase, stubbed: the gate is what is under test. */
const staffingUsecase = {
  getSnapshot: async (args) => {
    seen.staffing = args;
    return { as_of: `${DATE} 10:00`, expected_now: 0, recorded_in: 0, gap: 0 };
  },
  getRecurringGaps: async (args) => {
    seen.recurring = args;
    return { patterns: [], available: false };
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
  const routes = require("./attendance_dashboard")(usecase, permissions, null, staffingUsecase);
  router = routes.getRouter();
  app.use("/", router);

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ designationId = HR_ALL_STORES, userType = 1, expiry = "1d" } = {}) =>
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
  `/attendance/dashboard/recent-punches?attendance_date=${DATE}`,
  `/attendance/dashboard/staffing`,
  `/attendance/dashboard/recurring-gaps`,
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

    it(`${name} answers a caller holding the key AND a location scope`, async () => {
      const res = await call(endpoint, tokenFor({ designationId: HR_ALL_STORES }));
      assert.equal(res.status, 200);
      assert.equal(res.body.code, 200);
    });

    it(`${name} REFUSES a caller with the key but no location scope`, async () => {
      const res = await call(endpoint, tokenFor({ designationId: HR_EXECUTIVE }));
      assertRefused(res, "dashboard key but no branch authorization");
      assert.match(
        res.body.msg,
        /not authorized for any branch/i,
        "fails closed, and says why - it must not degrade to company-wide"
      );
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
    const ALL = { kind: SCOPE.ALL, store_ids: null };
    const LIST = { kind: SCOPE.LIST, store_ids: [2, 3] };
    const NONE = { kind: SCOPE.NONE, store_ids: [] };

    // Company-wide: the filter is an ordinary filter.
    assert.equal(effectiveStoreIds(null, ALL), null);
    assert.deepEqual(effectiveStoreIds("2", ALL), [2]);

    // A specific set: no filter means the whole set, never "everything".
    assert.deepEqual(effectiveStoreIds(null, LIST), [2, 3]);
    assert.deepEqual(effectiveStoreIds("", LIST), [2, 3]);
    assert.deepEqual(effectiveStoreIds("1,2,3", LIST), [2, 3], "the out-of-scope branch is dropped");

    // THE CASE THAT USED TO FAIL OPEN: asking for a branch you may not see
    // yields the EMPTY set, which every layer must read as "no data".
    assert.deepEqual(effectiveStoreIds("9", LIST), []);

    // No scope at all: nothing, whatever was asked for.
    assert.deepEqual(effectiveStoreIds(null, NONE), []);
    assert.deepEqual(effectiveStoreIds("1,2,3", NONE), []);
    assert.deepEqual(effectiveStoreIds(null, null), [], "an absent scope is not an open one");
  });

  it("an empty intersection is never mistaken for an absent filter", () => {
    const LIST = { kind: SCOPE.LIST, store_ids: [2] };
    const out = effectiveStoreIds("9", LIST);
    assert.ok(Array.isArray(out) && out.length === 0);
    assert.notEqual(out, null, "null would mean 'no restriction' - the exact fail-open being fixed");
  });

  it("resolves ALL only for an administrator or the all_stores grant", async () => {
    const has = (keys) => async (_req, key) => keys.includes(key);

    const admin = await resolveLocationScope(
      { decoded: { user_type: 2, designation_id: OUTLET_STAFF } },
      { ADMIN_USER_TYPE: 2, has: has([]) }
    );
    assert.equal(admin.kind, SCOPE.ALL);
    assert.equal(admin.reason, "ADMINISTRATOR");

    const allStores = await resolveLocationScope(
      { decoded: { user_type: 1, designation_id: HR_ALL_STORES } },
      { ADMIN_USER_TYPE: 2, has: has([ACCESS_ALL_STORES]) }
    );
    assert.equal(allStores.kind, SCOPE.ALL);
    assert.equal(allStores.reason, "ALL_STORES_PERMISSION");
  });

  it("neither attendance key establishes company-wide access", async () => {
    const scope = await resolveLocationScope(
      { decoded: { user_type: 1, designation_id: HR_EXECUTIVE } },
      {
        ADMIN_USER_TYPE: 2,
        has: async (_req, key) =>
          [P.VIEW_ATTENDANCE_DASHBOARD, P.VIEW_CALCULATED_ATTENDANCE].includes(key),
      }
    );
    assert.equal(scope.kind, SCOPE.NONE);
    assert.equal(scope.reason, "NO_LOCATION_SCOPE");
  });

  it("never derives a scope from the caller's own store_id", async () => {
    // The token carries store_id 2 throughout these tests. Promoting it to an
    // authorization boundary would be a per-store policy nobody approved.
    const scope = await resolveLocationScope(
      { decoded: { user_type: 1, designation_id: HR_EXECUTIVE, store_id: 2 } },
      { ADMIN_USER_TYPE: 2, has: async () => false }
    );
    assert.equal(scope.kind, SCOPE.NONE);
    assert.deepEqual(scope.store_ids, []);
  });

  it("an unauthenticated request resolves to NONE, not to ALL", async () => {
    const scope = await resolveLocationScope({}, { ADMIN_USER_TYPE: 2, has: async () => true });
    assert.equal(scope.kind, SCOPE.NONE);
    assert.equal(scope.reason, "UNAUTHENTICATED");
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

  it("the trend ACCEPTS the employee search, so the chart matches the cards", async () => {
    const res = await call(
      `/attendance/dashboard/trend?attendance_date=${DATE}&search=Priya`,
      tokenFor()
    );
    assert.equal(res.body.code, 200);
    assert.equal(seen.trend.search, "Priya");
  });

  it("the punch feed receives the selected date and every filter", async () => {
    await call(
      `/attendance/dashboard/recent-punches?attendance_date=${DATE}&store_ids=2&designation_id=5&work_shift_id=7&search=Priya`,
      tokenFor()
    );
    assert.equal(seen.recent.attendance_date, DATE);
    assert.deepEqual(seen.recent.store_ids, [2]);
    assert.equal(seen.recent.designation_id, 5);
    assert.equal(seen.recent.work_shift_id, 7);
    assert.equal(seen.recent.search, "Priya");
  });

  it("the punch feed refuses a request with no attendance date", async () => {
    const res = await call("/attendance/dashboard/recent-punches", tokenFor());
    assert.equal(res.body.code, 422, "a feed with no date cannot be evidence about a date");
  });

  it("the staffing snapshot takes no date: the server decides what 'now' is", async () => {
    const res = await call(`/attendance/dashboard/staffing?attendance_date=${DATE}`, tokenFor());
    assert.equal(
      res.body.code,
      422,
      "a caller-supplied date would put a past day's figures under a 'Now' heading"
    );
  });

  it("the staffing snapshot receives the scope and the filters", async () => {
    await call(
      "/attendance/dashboard/staffing?store_ids=2&designation_id=5&work_shift_id=7&search=Priya",
      tokenFor()
    );
    assert.deepEqual(seen.staffing.store_ids, [2]);
    assert.equal(seen.staffing.designation_id, 5);
    assert.equal(seen.staffing.work_shift_id, 7);
    assert.equal(seen.staffing.search, "Priya");
  });

  it("the drilldown carries the unassigned-location selection", async () => {
    await call(
      `/attendance/dashboard/drilldown?attendance_date=${DATE}&bucket=TOTAL&store_unassigned=true`,
      tokenFor()
    );
    assert.equal(seen.drilldown.store_unassigned, true);
  });
});
