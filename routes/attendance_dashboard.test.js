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
const buildDashboardScope = require("../middlewares/dashboard_scope");
const {
  DASHBOARD_SCOPE,
  DASHBOARD_SCOPE_KEY,
  decideScope,
  effectiveStoreIds,
  isWideningAttempt,
  parseRequestedStores,
} = require("../utils/dashboard_scope");

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
/** A branch manager: the dashboard key plus OWN STORE scope. */
const STORE_MANAGER = 11;
/** Both scope keys ticked - a configuration fault that must fail closed. */
const CONFLICTED = 12;
/** Own Store, but the employee record has no branch on it. */
const NO_BRANCH = 13;

/**
 * THE APPLICATION-WIDE PERMISSION THAT IS NO LONGER A DASHBOARD SCOPE.
 *
 * `all_stores` still exists and still means what it always meant elsewhere in
 * the application. It is deliberately granted to nobody here, and one test
 * below asserts that holding it alone now buys NO dashboard access at all -
 * dashboard scope is its own explicit grant.
 */
const ACCESS_ALL_STORES = "all_stores";

const GRANTS = {
  [HR_ALL_STORES]: [
    P.VIEW_ATTENDANCE_DASHBOARD,
    P.VIEW_CALCULATED_ATTENDANCE,
    P.DASHBOARD_SCOPE_ALL_STORES,
  ],
  [HR_EXECUTIVE]: [P.VIEW_ATTENDANCE_DASHBOARD, P.VIEW_CALCULATED_ATTENDANCE],
  [HR_ASSISTANT]: [P.VIEW_CALCULATED_ATTENDANCE],
  [OUTLET_STAFF]: [],
  [STORE_MANAGER]: [P.VIEW_ATTENDANCE_DASHBOARD, P.DASHBOARD_SCOPE_OWN_STORE],
  [CONFLICTED]: [
    P.VIEW_ATTENDANCE_DASHBOARD,
    P.DASHBOARD_SCOPE_OWN_STORE,
    P.DASHBOARD_SCOPE_ALL_STORES,
  ],
  [NO_BRANCH]: [P.VIEW_ATTENDANCE_DASHBOARD, P.DASHBOARD_SCOPE_OWN_STORE],
};

/**
 * EMPLOYEE MASTER, as the scope repository reads it.
 *
 * `employeeStore` is what `new_employee.store_id` says RIGHT NOW - the fact the
 * resolver goes to the database for on every request, rather than trusting the
 * `store_id` baked into the token at login. Tests move an employee between
 * branches by changing this, which is what a transfer looks like to the
 * resolver.
 */
const MOOLAKULAM = 1;
const ECR = 2;
const employeeStore = { value: MOOLAKULAM, missingRow: false, status: 1 };

const dashboardScopeRepo = {
  getEmployeeStore: async (employeeId) => {
    seen.scopeLookup = employeeId;
    if (employeeStore.missingRow) return null;
    if (employeeStore.throws) throw new Error("employee read failed");
    return {
      employee_id: employeeId,
      store_id: employeeStore.value,
      // The same row carries the branch AND whether they still work here.
      employee_status: employeeStore.status,
      outlet_name: employeeStore.value === MOOLAKULAM ? "Moolakulam" : "ECR",
      outlet_nickname: null,
    };
  },
};

const DATE = "2026-09-12";

/** What the usecase was asked, so a scope test can inspect it. */
const seen = { overview: null, drilldown: null, trend: null, recent: null, scopeLookup: null };

const usecase = {
  getFilters: async (args) => ({
    outlets: [
      { store_id: 1, outlet_name: "Main Store" },
      { store_id: 2, outlet_name: "Warehouse" },
    ],
    designations: [{ designation_id: 5, designation_name: "Cashier" }],
    shifts: [{ work_shift_id: 7, shift_code: "10-10", shift_name: "Shift 7" }],
    today: DATE,
    _asked: (seen.filters = args),
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
  getStaffingDrilldown: async (args) => {
    seen.staffingDrilldown = args;
    return {
      as_of: `${DATE} 10:00`,
      bucket: args.bucket,
      total: 0,
      rows: [],
      limit: args.limit || 50,
      offset: args.offset || 0,
      applied_filters: { store_ids: args.store_ids, store_id: args.store_id },
    };
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
  const dashboardScope = buildDashboardScope(permissions, dashboardScopeRepo);
  const routes = require("./attendance_dashboard")(
    usecase,
    permissions,
    null,
    staffingUsecase,
    dashboardScope
  );
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
  `/attendance/dashboard/staffing/drilldown?bucket=GAP`,
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

  it("NARROWS the request against the scope and can never widen it", () => {
    const ALL = { kind: DASHBOARD_SCOPE.ALL_STORES, store_ids: null };
    const OWN = { kind: DASHBOARD_SCOPE.OWN_STORE, store_ids: [2] };
    const NONE = { kind: DASHBOARD_SCOPE.NONE, store_ids: [] };
    const asked = (q) => parseRequestedStores(q);

    // Company-wide: the filter is an ordinary filter.
    assert.equal(effectiveStoreIds(ALL, asked(null)), null);
    assert.deepEqual(effectiveStoreIds(ALL, asked("2")), [2]);

    // Own Store: ALWAYS the assigned branch, whatever was asked for. There is
    // no arithmetic to get wrong here - the answer does not depend on the
    // request at all, which is the point.
    assert.deepEqual(effectiveStoreIds(OWN, asked(null)), [2]);
    assert.deepEqual(effectiveStoreIds(OWN, asked("")), [2]);
    assert.deepEqual(effectiveStoreIds(OWN, asked("2")), [2]);
    assert.deepEqual(effectiveStoreIds(OWN, asked("1,2,3")), [2]);
    assert.deepEqual(effectiveStoreIds(OWN, asked("9")), [2]);

    // No scope at all: nothing, whatever was asked for.
    assert.deepEqual(effectiveStoreIds(NONE, asked(null)), []);
    assert.deepEqual(effectiveStoreIds(NONE, asked("1,2,3")), []);
    assert.deepEqual(effectiveStoreIds(null, asked(null)), [], "an absent scope is not an open one");
  });

  it("AN OWN STORE REQUEST NAMING ANOTHER BRANCH IS A WIDENING ATTEMPT", () => {
    // Refused rather than silently narrowed: quietly returning the caller's own
    // figures under another branch's heading is worse than saying no.
    const OWN = { kind: DASHBOARD_SCOPE.OWN_STORE, store_ids: [2] };
    assert.equal(isWideningAttempt(OWN, parseRequestedStores("9")), true);
    assert.equal(isWideningAttempt(OWN, parseRequestedStores("2,9")), true, "even alongside its own");
    assert.equal(isWideningAttempt(OWN, parseRequestedStores("2")), false);
    assert.equal(isWideningAttempt(OWN, parseRequestedStores(null)), false, "omitting it is not asking");
    // All Stores has nothing outside it, and NONE never reaches a handler.
    assert.equal(
      isWideningAttempt({ kind: DASHBOARD_SCOPE.ALL_STORES, store_ids: null }, [9]),
      false
    );
  });

  it("an empty scope is never mistaken for an absent filter", () => {
    const out = effectiveStoreIds({ kind: DASHBOARD_SCOPE.NONE, store_ids: [] }, [9]);
    assert.ok(Array.isArray(out) && out.length === 0);
    assert.notEqual(out, null, "null would mean 'no restriction' - the exact fail-open being prevented");
  });

  it("AN ADMINISTRATOR IS ALL STORES, decided before the conflict rule", () => {
    // It has to be checked first: the permission middleware gives user_type 2
    // every row of `all_permissions`, so an administrator necessarily holds BOTH
    // scope keys. Applying the both-keys rule to them would lock every
    // administrator out of every dashboard.
    const admin = decideScope({ is_admin: true, has_all_stores: true, has_own_store: true });
    assert.equal(admin.kind, DASHBOARD_SCOPE.ALL_STORES);
    assert.equal(admin.reason, "ADMINISTRATOR");
  });

  it("BOTH SCOPE KEYS ON A NON-ADMINISTRATOR FAILS CLOSED", () => {
    // The two keys are meant to be exclusive and the rights table cannot enforce
    // it. Guessing would turn a mis-click into company-wide attendance access.
    const both = decideScope({ has_all_stores: true, has_own_store: true });
    assert.equal(both.kind, DASHBOARD_SCOPE.NONE);
    assert.equal(both.reason, "CONFLICTING_SCOPE");
  });

  it("each scope key resolves to its own scope, and neither key means NONE", () => {
    assert.equal(decideScope({ has_all_stores: true }).kind, DASHBOARD_SCOPE.ALL_STORES);
    assert.equal(decideScope({ has_own_store: true }).kind, DASHBOARD_SCOPE.OWN_STORE);
    const none = decideScope({});
    assert.equal(none.kind, DASHBOARD_SCOPE.NONE);
    assert.equal(none.reason, "NO_SCOPE_GRANTED");
  });

  it("THE DASHBOARD FEATURE KEY ESTABLISHES NO LOCATION AT ALL", async () => {
    // Holding `view_attendance_dashboard` says which SCREEN may be opened. It
    // has never said which branches, and conflating the two is what the first
    // implementation did.
    const res = await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}`,
      tokenFor({ designationId: HR_EXECUTIVE })
    );
    assertRefused(res, "dashboard key with no scope key");
    assert.match(res.body.msg, /not authorized for any branch/i);
  });

  it("THE APPLICATION-WIDE all_stores PERMISSION IS NO LONGER A DASHBOARD SCOPE", async () => {
    // It still exists and still means what it means elsewhere; it simply does
    // not grant dashboard reach any more. Dashboard scope is its own explicit
    // grant, so an `all_stores` holder with no dashboard scope is refused.
    const permissions = buildPermissions({
      getPermissionById: async () =>
        [P.VIEW_ATTENDANCE_DASHBOARD, ACCESS_ALL_STORES].map((permission_key) => ({
          permission_key,
          is_active: 1,
        })),
    });
    const dashboards = buildDashboardScope(permissions, dashboardScopeRepo);
    const scope = await dashboards.resolveDashboardScope(
      { decoded: { user_type: 1, designation_id: 99, employee_id: EMPLOYEE_ID } },
      P.VIEW_ATTENDANCE_DASHBOARD
    );
    assert.equal(scope.kind, DASHBOARD_SCOPE.NONE);
    assert.equal(scope.reason, "NO_SCOPE_GRANTED");
  });

  it("never derives a scope from the caller's own token store_id", async () => {
    // The token carries store_id 2 throughout these tests. It is a copy taken at
    // login and never refreshed, so it is not an authorization boundary - the
    // resolver goes to Employee Master for the branch, every request.
    const permissions = buildPermissions({ getPermissionById: async () => [] });
    const dashboards = buildDashboardScope(permissions, dashboardScopeRepo);
    const scope = await dashboards.resolveDashboardScope(
      { decoded: { user_type: 1, designation_id: OUTLET_STAFF, store_id: 2, employee_id: EMPLOYEE_ID } },
      P.VIEW_ATTENDANCE_DASHBOARD
    );
    assert.equal(scope.kind, DASHBOARD_SCOPE.NONE);
    assert.deepEqual(scope.store_ids, []);
  });

  it("an unauthenticated request resolves to NONE, not to ALL", async () => {
    const permissions = buildPermissions({ getPermissionById: async () => [] });
    const dashboards = buildDashboardScope(permissions, dashboardScopeRepo);
    const scope = await dashboards.resolveDashboardScope({}, P.VIEW_ATTENDANCE_DASHBOARD);
    assert.equal(scope.kind, DASHBOARD_SCOPE.NONE);
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

/* ==================================================================== */
/* THE STAFFING DRILLDOWN at the route level.                            */
/* ==================================================================== */

describe("the staffing drilldown endpoint", () => {
  it("takes no attendance_date either - it answers about now", async () => {
    const res = await call(
      `/attendance/dashboard/staffing/drilldown?bucket=GAP&attendance_date=${DATE}`,
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("requires a bucket rather than defaulting to one", async () => {
    const res = await call("/attendance/dashboard/staffing/drilldown", tokenFor());
    assert.equal(res.body.code, 422, "answering 'everybody' to a missing bucket would be a guess");
  });

  it("refuses a page larger than the cap", async () => {
    const res = await call(
      "/attendance/dashboard/staffing/drilldown?bucket=GAP&limit=5000",
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("refuses a negative offset", async () => {
    const res = await call(
      "/attendance/dashboard/staffing/drilldown?bucket=GAP&offset=-1",
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("refuses an unknown query parameter rather than ignoring it", async () => {
    const res = await call(
      "/attendance/dashboard/staffing/drilldown?bucket=GAP&include_salary=true",
      tokenFor()
    );
    assert.equal(res.body.code, 422);
  });

  it("passes the bucket, the paging and every filter through", async () => {
    await call(
      "/attendance/dashboard/staffing/drilldown?bucket=NO_CHECK_IN&store_ids=2&store_id=2" +
        "&designation_id=5&work_shift_id=7&search=%20Priya%20&gap_class=NO_CHECK_IN&limit=25&offset=50",
      tokenFor()
    );
    assert.equal(seen.staffingDrilldown.bucket, "NO_CHECK_IN");
    assert.deepEqual(seen.staffingDrilldown.store_ids, [2]);
    assert.equal(seen.staffingDrilldown.store_id, 2);
    assert.equal(seen.staffingDrilldown.designation_id, 5);
    assert.equal(seen.staffingDrilldown.work_shift_id, 7);
    assert.equal(seen.staffingDrilldown.search, "Priya", "trimmed, like every other filter");
    assert.equal(seen.staffingDrilldown.gap_class, "NO_CHECK_IN");
    assert.equal(seen.staffingDrilldown.limit, 25);
    assert.equal(seen.staffingDrilldown.offset, 50);
  });

  it("A REQUESTED LOCATION REACHES THE USECASE AS A FILTER, never as authorization", async () => {
    // The route hands both down; the intersection happens in the usecase, where
    // an id outside the caller's scope yields nothing rather than widening it.
    // Here the scope is ALL, so the requested id is simply passed on.
    await call("/attendance/dashboard/staffing/drilldown?bucket=EXPECTED&store_id=2", tokenFor());
    assert.equal(seen.staffingDrilldown.store_id, 2);
    assert.equal(seen.staffingDrilldown.store_ids, null, "an unfiltered ALL scope narrows nothing");
  });

  it("AN OWN STORE CALLER CANNOT PAGE INTO ANOTHER BRANCH", async () => {
    // The drilldown is the most tempting way in: a bucket, a store_id and an
    // offset. An Own Store caller naming another branch is refused outright
    // rather than handed their own branch's rows under that heading.
    const res = await call(
      "/attendance/dashboard/staffing/drilldown?bucket=EXPECTED&store_ids=9",
      tokenFor({ designationId: STORE_MANAGER })
    );
    assertRefused(res, "own-store caller paging into another branch");
    assert.match(res.body.msg, /only authorized for your own branch/i);
  });

  it("an out-of-scope store filter never becomes an absent one", () => {
    // The failure mode this guards is the classic one: an empty authorized set
    // collapsing into null, which every layer reads as "no restriction".
    const OWN = { kind: DASHBOARD_SCOPE.OWN_STORE, store_ids: [2] };
    assert.deepEqual(effectiveStoreIds(OWN, parseRequestedStores("1")), [2]);
    assert.deepEqual(effectiveStoreIds({ kind: DASHBOARD_SCOPE.NONE, store_ids: [] }, null), []);
    assert.notEqual(
      effectiveStoreIds({ kind: DASHBOARD_SCOPE.NONE, store_ids: [] }, null),
      null
    );
  });

  it("sets no-store, so a shared cache cannot serve one person's list to another", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/attendance/dashboard/staffing/drilldown?bucket=GAP`,
      { headers: { "x-access-token": await tokenFor() } }
    );
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("the recurring-gaps panel takes the effective shift filter too", async () => {
    await call(
      "/attendance/dashboard/recurring-gaps?store_ids=2&designation_id=5&work_shift_id=7&search=Priya",
      tokenFor()
    );
    assert.deepEqual(seen.recurring.store_ids, [2]);
    assert.equal(seen.recurring.work_shift_id, 7, "narrowed the same way as the cards above it");
    assert.equal(seen.recurring.designation_id, 5);
    assert.equal(seen.recurring.search, "Priya");
  });
});

/* ==================================================================== */
/* GLOBAL DASHBOARD ACCESS - the scope, end to end over a real server.   */
/*                                                                      */
/* Every case here is decided by the SERVER. The browser is not involved */
/* in any of them, and none of them can be changed by anything a caller  */
/* sends.                                                               */
/* ==================================================================== */

describe("Own Store scope", () => {
  const reset = () => {
    employeeStore.value = MOOLAKULAM;
    employeeStore.missingRow = false;
    employeeStore.throws = false;
    employeeStore.status = 1;
  };

  it("PINS EVERY ENDPOINT to the employee's assigned branch", async () => {
    reset();
    const token = tokenFor({ designationId: STORE_MANAGER });

    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, token);
    assert.deepEqual(seen.overview.store_ids, [MOOLAKULAM]);

    await call(`/attendance/dashboard/trend?attendance_date=${DATE}`, token);
    assert.deepEqual(seen.trend.store_ids, [MOOLAKULAM]);

    await call(`/attendance/dashboard/recent-punches?attendance_date=${DATE}`, token);
    assert.deepEqual(seen.recent.store_ids, [MOOLAKULAM]);

    await call("/attendance/dashboard/staffing", token);
    assert.deepEqual(seen.staffing.store_ids, [MOOLAKULAM]);

    await call("/attendance/dashboard/staffing/drilldown?bucket=GAP", token);
    assert.deepEqual(seen.staffingDrilldown.store_ids, [MOOLAKULAM]);

    await call("/attendance/dashboard/recurring-gaps", token);
    assert.deepEqual(seen.recurring.store_ids, [MOOLAKULAM]);

    await call(`/attendance/dashboard/drilldown?attendance_date=${DATE}&bucket=TOTAL`, token);
    assert.deepEqual(seen.drilldown.store_ids, [MOOLAKULAM]);
  });

  it("CANNOT BE WIDENED by a query parameter, however it is spelled", async () => {
    reset();
    const token = tokenFor({ designationId: STORE_MANAGER });
    for (const q of ["store_ids=2", "store_ids=1,2", "store_ids=2,3,4"]) {
      const res = await call(`/attendance/dashboard/overview?attendance_date=${DATE}&${q}`, token);
      assertRefused(res, q);
      assert.match(res.body.msg, /only authorized for your own branch/i);
    }
    // And asking for exactly its own branch is simply allowed, unchanged.
    await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&store_ids=${MOOLAKULAM}`,
      token
    );
    assert.deepEqual(seen.overview.store_ids, [MOOLAKULAM]);
  });

  it("the filters endpoint exposes ONLY the authorized branch", async () => {
    reset();
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(res.body.code, 200);
    // THE USECASE WAS ASKED FOR ONE BRANCH. That is what stops the selector
    // enumerating the company - `getFilters` returns no outlet outside the
    // `store_ids` it is given, and it is given exactly the authorized one.
    assert.deepEqual(seen.filters.store_ids, [MOOLAKULAM]);
    assert.deepEqual(res.body.dashboard_scope.store_ids, [MOOLAKULAM]);
    assert.equal(res.body.dashboard_scope.can_choose_outlet, false);
    assert.equal(res.body.dashboard_scope.kind, "OWN_STORE");
    assert.equal(res.body.dashboard_scope.outlet_name, "Moolakulam");
  });

  it("tells the browser the scope WITHOUT leaking keys or other branches", async () => {
    reset();
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    const payload = JSON.stringify(res.body.dashboard_scope);
    assert.doesNotMatch(payload, /dashboard_scope_own_store|dashboard_scope_all_stores|all_stores/);
    assert.doesNotMatch(payload, /ECR/, "no branch the caller cannot see is named");
    assert.doesNotMatch(payload, /reason/i, "a successful resolve needs no reason code");
  });

  it("DOES NOT DISCLOSE another branch's identity on a cross-location row", async () => {
    reset();
    await call("/attendance/dashboard/staffing", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(
      seen.staffing.disclose_other_locations,
      false,
      "the fact travels, the destination's name does not"
    );
    await call("/attendance/dashboard/staffing/drilldown?bucket=IN_ELSEWHERE", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(seen.staffingDrilldown.disclose_other_locations, false);
    await call(`/attendance/dashboard/recent-punches?attendance_date=${DATE}`, tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(seen.recent.disclose_other_locations, false);
  });

  it("search and the other filters still narrow, and still only inside scope", async () => {
    reset();
    await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&search=Priya&designation_id=5`,
      tokenFor({ designationId: STORE_MANAGER })
    );
    assert.equal(seen.overview.search, "Priya");
    assert.equal(seen.overview.designation_id, 5);
    assert.deepEqual(seen.overview.store_ids, [MOOLAKULAM], "a search cannot reach outside the branch");
  });
});

describe("All Stores scope", () => {
  it("reads company-wide and may use the outlet filter normally", async () => {
    const token = tokenFor({ designationId: HR_ALL_STORES });
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, token);
    assert.equal(seen.overview.store_ids, null, "no restriction");

    await call(`/attendance/dashboard/overview?attendance_date=${DATE}&store_ids=2`, token);
    assert.deepEqual(seen.overview.store_ids, [2], "and a filter is an ordinary filter");
  });

  it("is offered the outlet picker, and is told so", async () => {
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(seen.filters.store_ids, null, "no restriction on the option list either");
    assert.equal(res.body.dashboard_scope.kind, "ALL_STORES");
    assert.equal(res.body.dashboard_scope.can_choose_outlet, true);
    assert.deepEqual(res.body.dashboard_scope.store_ids, []);
  });

  it("may be told where a cross-location punch happened", async () => {
    await call("/attendance/dashboard/staffing", tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(seen.staffing.disclose_other_locations, true);
  });
});

describe("the administrator", () => {
  it("is All Stores by user type, with no dashboard scope granted", async () => {
    // OUTLET_STAFF holds nothing at all; user_type 2 is the whole reason this
    // works, and it is the system's existing single administrator concept.
    const token = tokenFor({ designationId: OUTLET_STAFF, userType: 2 });
    const res = await call("/attendance/dashboard/filters", token);
    assert.equal(res.body.code, 200);
    assert.equal(res.body.dashboard_scope.kind, "ALL_STORES");
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, token);
    assert.equal(seen.overview.store_ids, null);
  });

  it("needs no employee lookup at all", async () => {
    seen.scopeLookup = null;
    await call("/attendance/dashboard/filters", tokenFor({ designationId: OUTLET_STAFF, userType: 2 }));
    assert.equal(seen.scopeLookup, null, "All Stores never asks which branch somebody works at");
  });
});

describe("scopes that cannot be resolved fail closed", () => {
  it("BOTH SCOPE KEYS is refused, and says what is wrong", async () => {
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: CONFLICTED }));
    assertRefused(res, "both scope keys");
    assert.equal(res.body.reason, "CONFLICTING_SCOPE");
    assert.match(res.body.msg, /exactly one must be granted/i);
  });

  it("OWN STORE WITH NO BRANCH ASSIGNED is refused, never widened", async () => {
    employeeStore.value = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assertRefused(res, "no branch on the employee record");
    assert.equal(res.body.reason, "NO_STORE_ASSIGNED");
    employeeStore.value = MOOLAKULAM;
  });

  it("A LOGIN WITH NO EMPLOYEE ROW is refused", async () => {
    employeeStore.missingRow = true;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assertRefused(res, "no employee record");
    assert.equal(res.body.reason, "NO_EMPLOYEE_RECORD");
    employeeStore.missingRow = false;
  });

  it("A FAILED EMPLOYEE LOOKUP IS A REFUSAL, not an open door", async () => {
    employeeStore.throws = true;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assertRefused(res, "employee lookup threw");
    employeeStore.throws = false;
  });

  it("no dashboard feature key is refused before any branch is looked up", async () => {
    seen.scopeLookup = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: OUTLET_STAFF }));
    assertRefused(res, "no feature key");
    assert.equal(res.body.reason, "NO_DASHBOARD_PERMISSION");
    assert.equal(seen.scopeLookup, null, "a refusal must not differ by whether they have a branch");
  });
});

describe("the login-user to employee to branch mapping", () => {
  it("A TRANSFER IN EMPLOYEE MASTER TAKES EFFECT ON THE NEXT REQUEST", async () => {
    // The same token throughout - nobody logs out. The branch is read live, so
    // moving the employee moves the scope.
    const token = tokenFor({ designationId: STORE_MANAGER });
    employeeStore.value = MOOLAKULAM;
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, token);
    assert.deepEqual(seen.overview.store_ids, [MOOLAKULAM]);

    employeeStore.value = ECR;
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, token);
    assert.deepEqual(seen.overview.store_ids, [ECR], "the new branch, without re-logging in");

    // And the branch they LEFT is now out of scope for them.
    const refused = await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&store_ids=${MOOLAKULAM}`,
      token
    );
    assertRefused(refused, "the branch they were transferred out of");
    employeeStore.value = MOOLAKULAM;
  });

  it("THE STALE store_id IN THE TOKEN IS IGNORED", async () => {
    // Every token in this file carries store_id 2. The assigned branch is 1.
    // If the token's copy were ever used, this would read branch 2.
    employeeStore.value = MOOLAKULAM;
    await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}`,
      tokenFor({ designationId: STORE_MANAGER })
    );
    assert.deepEqual(seen.overview.store_ids, [MOOLAKULAM]);
    assert.notDeepEqual(seen.overview.store_ids, [2], "the token's store_id decided nothing");
  });

  it("the branch is resolved from the employee id, on every request", async () => {
    employeeStore.value = MOOLAKULAM;
    seen.scopeLookup = null;
    await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(seen.scopeLookup, EMPLOYEE_ID, "by employee id, not user id or store id");
  });

  it("a permission change takes effect without a new token", async () => {
    // Same user, same token, different designation grants: the middleware reads
    // permissions per request (behind its own short cache), so scope follows.
    employeeStore.value = MOOLAKULAM;
    const own = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(own.body.dashboard_scope.kind, "OWN_STORE");
    const all = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(all.body.dashboard_scope.kind, "ALL_STORES");
  });
});

/* ==================================================================== */
/* AN INACTIVE EMPLOYEE HAS NO OWN STORE - over the real server.         */
/*                                                                      */
/* The premise: a token stays valid for its lifetime, the designation    */
/* keeps its grants, and `new_employee.status` is the only thing that    */
/* changed. The dashboard must refuse anyway.                            */
/* ==================================================================== */

describe("Own Store and employee status", () => {
  const active = () => {
    employeeStore.value = MOOLAKULAM;
    employeeStore.status = 1;
    employeeStore.missingRow = false;
    employeeStore.throws = false;
  };

  it("AN ACTIVE EMPLOYEE WITH A BRANCH IS ALLOWED, exactly as before", async () => {
    active();
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(res.body.code, 200);
    assert.deepEqual(res.body.dashboard_scope.store_ids, [MOOLAKULAM]);
  });

  it("AN INACTIVE EMPLOYEE IS REFUSED, and is NOT given their former branch", async () => {
    active();
    employeeStore.status = 0;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assertRefused(res, "inactive employee");
    assert.equal(res.body.reason, "EMPLOYEE_INACTIVE");
    assert.match(res.body.msg, /employee record is not active/i);
    // The branch must appear nowhere in the refusal.
    assert.doesNotMatch(JSON.stringify(res.body), /Moolakulam|store_ids/);
    active();
  });

  it("is refused on EVERY endpoint, not just the one the screen opens with", async () => {
    active();
    employeeStore.status = 0;
    const token = tokenFor({ designationId: STORE_MANAGER });
    const endpoints = [
      `/attendance/dashboard/overview?attendance_date=${DATE}`,
      `/attendance/dashboard/trend?attendance_date=${DATE}`,
      `/attendance/dashboard/recent-punches?attendance_date=${DATE}`,
      `/attendance/dashboard/drilldown?attendance_date=${DATE}&bucket=TOTAL`,
      "/attendance/dashboard/staffing",
      "/attendance/dashboard/staffing/drilldown?bucket=GAP",
      "/attendance/dashboard/recurring-gaps",
      "/attendance/dashboard/filters",
    ];
    for (const endpoint of endpoints) {
      const res = await call(endpoint, token);
      assertRefused(res, endpoint);
      assert.equal(res.body.reason, "EMPLOYEE_INACTIVE", endpoint);
    }
    active();
  });

  it("A STALE TOKEN NAMING THE OLD BRANCH BUYS NOTHING", async () => {
    // Every token here carries store_id 2. An inactive employee presenting it
    // must not get branch 2, branch 1, or anything else.
    active();
    employeeStore.status = 0;
    seen.overview = null;
    const res = await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&store_ids=2`,
      tokenFor({ designationId: STORE_MANAGER })
    );
    assertRefused(res, "inactive employee with a stale token branch");
    assert.equal(seen.overview, null, "the usecase was never reached");
    active();
  });

  it("cannot be rescued by asking for a branch explicitly", async () => {
    active();
    employeeStore.status = 0;
    const res = await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}&store_ids=${MOOLAKULAM}`,
      tokenFor({ designationId: STORE_MANAGER })
    );
    assertRefused(res, "inactive employee asking for their own former branch");
    active();
  });

  it("an inactive employee with NO branch is reported as inactive, not as a setup fault", async () => {
    // The fault that matters is the one somebody would act on. "No branch
    // assigned" invites an administrator to assign one; "not active" does not.
    active();
    employeeStore.status = 0;
    employeeStore.value = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(res.body.reason, "EMPLOYEE_INACTIVE");
    active();
  });

  it("ANY STATUS THAT IS NOT 1 IS INACTIVE", async () => {
    active();
    for (const status of [0, 2, null, undefined, "0"]) {
      employeeStore.status = status;
      const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
      assertRefused(res, `status ${JSON.stringify(status)}`);
      assert.equal(res.body.reason, "EMPLOYEE_INACTIVE", String(status));
    }
    active();
  });

  it("REACTIVATION RESTORES ACCESS with no change to the token", async () => {
    active();
    employeeStore.status = 0;
    assertRefused(
      await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER })),
      "inactive"
    );
    employeeStore.status = 1;
    const back = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(back.body.code, 200);
    assert.deepEqual(back.body.dashboard_scope.store_ids, [MOOLAKULAM]);
  });

  it("A TRANSFERRED ACTIVE EMPLOYEE still gets the CURRENT branch", async () => {
    // The status check must not disturb the transfer behaviour.
    active();
    employeeStore.value = ECR;
    await call(
      `/attendance/dashboard/overview?attendance_date=${DATE}`,
      tokenFor({ designationId: STORE_MANAGER })
    );
    assert.deepEqual(seen.overview.store_ids, [ECR]);
    active();
  });

  it("THE STATUS LOOKUP FAILING IS A REFUSAL, not a pass", async () => {
    active();
    employeeStore.throws = true;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assertRefused(res, "the employee read threw");
    assert.notEqual(res.body.code, 200);
    active();
  });

  it("no employee row is still NO_EMPLOYEE_RECORD, unchanged", async () => {
    active();
    employeeStore.missingRow = true;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(res.body.reason, "NO_EMPLOYEE_RECORD");
    active();
  });

  it("an ACTIVE employee with no branch is still NO_STORE_ASSIGNED, unchanged", async () => {
    active();
    employeeStore.value = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(res.body.reason, "NO_STORE_ASSIGNED");
    active();
  });

  it("THE ADMINISTRATOR IS UNAFFECTED - no employee lookup, no status check", async () => {
    // The admin path resolves before any of this. An administrator whose
    // employee row is inactive, missing, or unreadable still gets All Stores,
    // because `user_type` 2 is the grant and it was never an employee question.
    employeeStore.status = 0;
    employeeStore.missingRow = true;
    seen.scopeLookup = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: OUTLET_STAFF, userType: 2 }));
    assert.equal(res.body.code, 200);
    assert.equal(res.body.dashboard_scope.kind, "ALL_STORES");
    assert.equal(seen.scopeLookup, null, "it never asked");
    active();
  });

  it("AN INACTIVE ALL STORES USER IS REFUSED TOO", async () => {
    // This was the residual the previous pass left and reported: the employee
    // lookup sat inside the Own Store branch, so All Stores returned before it
    // ever ran and an employee who had left kept COMPANY-WIDE access on a token
    // still within its lifetime. The narrower scope was guarded and the wider
    // one was not, which is precisely backwards.
    active();
    employeeStore.status = 0;
    seen.scopeLookup = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assertRefused(res, "inactive employee holding All Stores");
    assert.equal(res.body.reason, "EMPLOYEE_INACTIVE");
    assert.equal(seen.scopeLookup, EMPLOYEE_ID, "the row IS read for All Stores now");
    active();
  });

  it("AN ACTIVE ALL STORES USER IS STILL COMPANY-WIDE", async () => {
    active();
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(res.body.code, 200);
    assert.equal(res.body.dashboard_scope.kind, "ALL_STORES");
    assert.equal(res.body.dashboard_scope.can_choose_outlet, true);
  });

  it("AN ACTIVE ALL STORES USER NEEDS NO ASSIGNED BRANCH", async () => {
    // The scope is "every branch", so which one they are assigned to decides
    // nothing. A missing outlet is fatal for Own Store and irrelevant here.
    active();
    employeeStore.value = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(res.body.code, 200);
    assert.equal(res.body.dashboard_scope.kind, "ALL_STORES");
    active();
  });

  it("an All Stores user with NO EMPLOYEE ROW is refused", async () => {
    active();
    employeeStore.missingRow = true;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assertRefused(res, "All Stores with no employee record");
    assert.equal(res.body.reason, "NO_EMPLOYEE_RECORD");
    active();
  });

  it("THE LOOKUP FAILING IS A REFUSAL FOR ALL STORES TOO", async () => {
    active();
    employeeStore.throws = true;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assertRefused(res, "the employee read threw for an All Stores caller");
    active();
  });

  it("an inactive All Stores user cannot reach any endpoint", async () => {
    active();
    employeeStore.status = 0;
    const token = tokenFor({ designationId: HR_ALL_STORES });
    for (const endpoint of [
      `/attendance/dashboard/overview?attendance_date=${DATE}`,
      "/attendance/dashboard/staffing",
      "/attendance/dashboard/staffing/drilldown?bucket=GAP",
      "/attendance/dashboard/recurring-gaps",
    ]) {
      const res = await call(endpoint, token);
      assertRefused(res, endpoint);
      assert.equal(res.body.reason, "EMPLOYEE_INACTIVE", endpoint);
    }
    active();
  });

  it("the both-scope conflict is still refused, and still says so", async () => {
    active();
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: CONFLICTED }));
    assert.equal(res.body.reason, "CONFLICTING_SCOPE");
  });

  it("the dashboard feature key is still required, and still checked first", async () => {
    active();
    employeeStore.status = 0;
    seen.scopeLookup = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: OUTLET_STAFF }));
    assert.equal(res.body.reason, "NO_DASHBOARD_PERMISSION");
    assert.equal(seen.scopeLookup, null, "a refusal must not differ by employee status");
    active();
  });
});

/* ==================================================================== */
/* THE RESOLVER ORDER ITSELF.                                           */
/*                                                                      */
/* Active employment is a PREREQUISITE for every non-administrator,      */
/* answered above the Own Store / All Stores split - not a detail of one */
/* branch. These pin the order, because the order IS the security.      */
/* ==================================================================== */

describe("the resolver order", () => {
  const active = () => {
    employeeStore.value = MOOLAKULAM;
    employeeStore.status = 1;
    employeeStore.missingRow = false;
    employeeStore.throws = false;
  };

  it("THE ADMINISTRATOR IS DECIDED BEFORE ANY EMPLOYEE QUESTION IS ASKED", async () => {
    // No employee row, inactive, and the lookup would throw if reached. An
    // administrator is authorized by user type and asks none of it.
    employeeStore.missingRow = true;
    employeeStore.status = 0;
    employeeStore.throws = true;
    seen.scopeLookup = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: OUTLET_STAFF, userType: 2 }));
    assert.equal(res.body.code, 200);
    assert.equal(res.body.dashboard_scope.kind, "ALL_STORES");
    assert.equal(seen.scopeLookup, null, "it never asked");
    active();
  });

  it("the feature key is checked BEFORE the employee row", async () => {
    // A refusal must not differ in shape or timing by whether the caller
    // happens to be an active employee.
    active();
    employeeStore.status = 0;
    seen.scopeLookup = null;
    const res = await call("/attendance/dashboard/filters", tokenFor({ designationId: OUTLET_STAFF }));
    assert.equal(res.body.reason, "NO_DASHBOARD_PERMISSION");
    assert.equal(seen.scopeLookup, null);
    active();
  });

  it("the SCOPE KEYS are resolved before the employee row", async () => {
    // Both keys, or neither, is a rights-configuration fault and is answered as
    // one - reading Employee Master first would report the wrong problem.
    active();
    employeeStore.status = 0;
    seen.scopeLookup = null;
    const both = await call("/attendance/dashboard/filters", tokenFor({ designationId: CONFLICTED }));
    assert.equal(both.body.reason, "CONFLICTING_SCOPE");
    assert.equal(seen.scopeLookup, null, "a conflict needs no employee row");

    seen.scopeLookup = null;
    const none = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_EXECUTIVE }));
    assert.equal(none.body.reason, "NO_SCOPE_GRANTED");
    assert.equal(seen.scopeLookup, null, "nor does an absent scope");
    active();
  });

  it("BOTH NON-ADMIN SCOPES GO THROUGH THE SAME EMPLOYEE CHECK", async () => {
    // One lookup, above the split. The same inactive employee is refused with
    // the same reason whichever scope their designation holds.
    active();
    employeeStore.status = 0;
    for (const designationId of [STORE_MANAGER, HR_ALL_STORES]) {
      seen.scopeLookup = null;
      const res = await call("/attendance/dashboard/filters", tokenFor({ designationId }));
      assert.equal(res.body.reason, "EMPLOYEE_INACTIVE", String(designationId));
      assert.equal(seen.scopeLookup, EMPLOYEE_ID, String(designationId));
    }
    active();
  });

  it("A MISSING BRANCH SEPARATES THE TWO SCOPES, and only there", async () => {
    // The one place they legitimately differ: Own Store needs the branch, All
    // Stores does not. Both start from the same active employee.
    active();
    employeeStore.value = null;
    const own = await call("/attendance/dashboard/filters", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(own.body.reason, "NO_STORE_ASSIGNED");
    const all = await call("/attendance/dashboard/filters", tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(all.body.code, 200);
    assert.equal(all.body.dashboard_scope.kind, "ALL_STORES");
    active();
  });

  it("a transferred ACTIVE employee still follows Employee Master", async () => {
    // The reordering must not disturb the transfer behaviour.
    active();
    employeeStore.value = ECR;
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, tokenFor({ designationId: STORE_MANAGER }));
    assert.deepEqual(seen.overview.store_ids, [ECR]);
    active();
  });

  it("the stale token store_id still decides nothing", async () => {
    // Every token here carries store_id 2; the assigned branch is 1.
    active();
    await call(`/attendance/dashboard/overview?attendance_date=${DATE}`, tokenFor({ designationId: STORE_MANAGER }));
    assert.deepEqual(seen.overview.store_ids, [MOOLAKULAM]);
    assert.notDeepEqual(seen.overview.store_ids, [2]);
  });
});
