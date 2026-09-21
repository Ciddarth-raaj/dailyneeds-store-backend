/**
 * THE SHIFT CHANGE ELIGIBILITY REPORT API - AUTHORIZATION AND EXPORT PARITY,
 * over a real Express server.
 *
 *   node --test routes/attendance_shift_change_report.test.js
 *
 * The one thing that must be true of a new cross-branch report is that it
 * widens NOBODY: a branch user who could see one outlet yesterday still sees
 * one outlet today, and a caller without the key sees nothing at all. Hiding
 * a menu entry is presentation; this is what actually refuses. NO OUTLET ID
 * SENT BY THE BROWSER IS TRUSTED, and the tests below prove it by sending one
 * the caller may not have.
 *
 * THE EXPORT IS HELD TO THE SAME FILTERS AND THE SAME SCOPE AS THE SCREEN,
 * which is asserted directly: both routes are called with the same query and
 * what the usecase was asked is compared.
 *
 * A real `jwt` and the real `auth`, `permissions` and `dashboard_scope`
 * middleware are used. Only the usecase is a stub, because what is under test
 * is the gate and the `store_ids` it hands over - not the eligibility, which
 * `usecase/attendance_shift_change_report.test.js` covers.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-att-shift-change-"));
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

const USER_ID = 7;
const EMPLOYEE_ID = 1003;
const MOOLAKULAM = 1;
const ECR = 2;

/**
 *   HR_ALL_STORES   the report key AND company-wide dashboard scope.
 *   HR_EXPORTER     the same, plus the export key.
 *   STORE_MANAGER   the report key and OWN STORE scope - one branch, and the
 *                   branch is the server's fact, not the token's.
 *   NO_SCOPE        the report key alone. Permitted to use the screen, no
 *                   location authorization - so it refuses. Fail closed.
 *   DASHBOARD_ONLY  the ATTENDANCE DASHBOARD key but NOT this report's. The
 *                   new report is its own grant and this proves it.
 *   OUTLET_STAFF    nothing at all.
 */
const HR_ALL_STORES = 8;
const HR_EXPORTER = 9;
const STORE_MANAGER = 11;
const NO_SCOPE = 14;
const DASHBOARD_ONLY = 15;
const OUTLET_STAFF = 4;

const GRANTS = {
  [HR_ALL_STORES]: [P.VIEW_SHIFT_CHANGE_ELIGIBILITY_REPORT, P.DASHBOARD_SCOPE_ALL_STORES],
  [HR_EXPORTER]: [
    P.VIEW_SHIFT_CHANGE_ELIGIBILITY_REPORT,
    P.EXPORT_SHIFT_CHANGE_ELIGIBILITY_REPORT,
    P.DASHBOARD_SCOPE_ALL_STORES,
  ],
  [STORE_MANAGER]: [
    P.VIEW_SHIFT_CHANGE_ELIGIBILITY_REPORT,
    P.EXPORT_SHIFT_CHANGE_ELIGIBILITY_REPORT,
    P.DASHBOARD_SCOPE_OWN_STORE,
  ],
  [NO_SCOPE]: [P.VIEW_SHIFT_CHANGE_ELIGIBILITY_REPORT],
  [DASHBOARD_ONLY]: [P.VIEW_ATTENDANCE_DASHBOARD, P.DASHBOARD_SCOPE_ALL_STORES],
  [OUTLET_STAFF]: [],
};

const employeeStore = { value: MOOLAKULAM, status: 1 };
const dashboardScopeRepo = {
  getEmployeeStore: async (employeeId) => ({
    employee_id: employeeId,
    store_id: employeeStore.value,
    employee_status: employeeStore.status,
    outlet_name: employeeStore.value === MOOLAKULAM ? "Moolakulam" : "ECR",
    outlet_nickname: null,
  }),
};

/** What the usecase was asked, so a scope and export test can inspect it. */
const seen = { report: null, calls: 0 };
const usecase = {
  getReport: async (filters) => {
    seen.report = filters;
    seen.calls += 1;
    return {
      meta: {
        from_date: filters.from_date,
        to_date: filters.to_date,
        today: "2026-09-19",
        row_count: 1,
        employee_count: 1,
        actionable_count: 1,
      },
      data: [
        {
          attendance_date: "2026-09-18",
          employee_id: 42,
          employee_name: "Employee 42",
          outlet_name: "Moolakulam",
          designation_name: "Cashier",
          assigned_shift_name: "Evening",
          assigned_shift_code: "S7",
          assigned_shift_in_time: "18:00:00",
          assigned_shift_out_time: "22:00:00",
          assigned_nrm_minutes: 240,
          first_punch: "10:00",
          last_punch: "22:00",
          worked_minutes: 720,
          worked_hours: "12:00",
          extra_minutes: 480,
          extra_hours: "8:00",
          can_raise: true,
          worked_longer: true,
          eligibility_reason_code: "ELIGIBLE",
          eligibility_reason: "A longer shift is available for this date",
          request_status: "Not Raised",
          request_id: null,
        },
      ],
    };
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
  delete require.cache[require.resolve("./attendance_shift_change_report")];
  const dashboardScope = buildDashboardScope(permissions, dashboardScopeRepo);
  const routes = require("./attendance_shift_change_report")(usecase, permissions, null, dashboardScope);
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
      // The token claims a branch the employee is NOT in, deliberately: the
      // resolver must go to the database and ignore this.
      designation_id: designationId,
      store_id: ECR,
    },
    expiry
  );

const call = async (p, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: token ? { "x-access-token": await token } : {},
  });
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("spreadsheet")) {
    return { status: res.status, spreadsheet: true, body: { code: 200 } };
  }
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
 * The refusal code is in the BODY as well as the status - `middlewares/auth.js`
 * answers a 403 as HTTP 200 with `{code: 403}` so the frontend can redirect -
 * so both halves are asserted. A test on the status alone would pass on a
 * wide-open endpoint that answered 200 with data.
 */
const assertRefused = (res, what) => {
  assert.ok(
    res.body && (res.body.code === 401 || res.body.code === 403),
    `${what}: expected a 401/403 refusal, got HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`
  );
  assert.notEqual(res.body.code, 200, `${what}: must not answer with data`);
};

const RANGE = "from_date=2026-09-01&to_date=2026-09-19";
const ROWS = `/attendance/reports/shift-change-eligibility?${RANGE}`;
const EXPORT = `/attendance/reports/shift-change-eligibility/export.xlsx?${RANGE}`;

describe("every route is gated, individually", () => {
  it("lists exactly the two GET routes this router declares, and no write route", () => {
    const declared = router.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    assert.deepEqual(
      declared.map((r) => r.path).sort(),
      ["/attendance/reports/shift-change-eligibility", "/attendance/reports/shift-change-eligibility/export.xlsx"]
    );
    declared.forEach((r) => assert.deepEqual(r.methods, ["get"], `${r.path} must be GET-only`));
  });

  it("refuses a signed-out caller on both routes", async () => {
    assertRefused(await call(ROWS, null), "rows, signed out");
    assertRefused(await call(EXPORT, null), "export, signed out");
  });

  it("refuses an expired token on both routes", async () => {
    const expired = tokenFor({ expiry: "-1s" });
    assertRefused(await call(ROWS, expired), "rows, expired");
    assertRefused(await call(EXPORT, expired), "export, expired");
  });

  it("refuses a signed-in caller with no permissions at all", async () => {
    const token = tokenFor({ designationId: OUTLET_STAFF });
    assertRefused(await call(ROWS, token), "rows, no grants");
    assertRefused(await call(EXPORT, token), "export, no grants");
  });

  it("refuses a caller holding the ATTENDANCE DASHBOARD key but not this report's", async () => {
    const token = tokenFor({ designationId: DASHBOARD_ONLY });
    assertRefused(await call(ROWS, token), "rows, dashboard key only");
  });

  it("refuses a caller with the key but NO location scope - fails closed", async () => {
    const token = tokenFor({ designationId: NO_SCOPE });
    assertRefused(await call(ROWS, token), "rows, no scope");
  });

  it("answers a caller holding the key and a scope", async () => {
    const res = await call(ROWS, tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(res.body.code, 200);
    assert.equal(res.body.data.length, 1);
  });
});

describe("the export needs its own second key", () => {
  it("refuses a caller who may READ the report but not export it", async () => {
    const token = tokenFor({ designationId: HR_ALL_STORES });
    const rows = await call(ROWS, token);
    assert.equal(rows.body.code, 200, "the screen is permitted");
    assertRefused(await call(EXPORT, token), "export without the export key");
  });

  it("serves a spreadsheet to a caller holding both keys", async () => {
    const res = await call(EXPORT, tokenFor({ designationId: HR_EXPORTER }));
    assert.equal(res.status, 200);
    assert.ok(res.spreadsheet, "expected an xlsx response");
  });
});

describe("a new report widens nobody", () => {
  it("pins a branch manager to THEIR OWN branch, ignoring the token's store_id", async () => {
    employeeStore.value = MOOLAKULAM;
    const res = await call(ROWS, tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(res.body.code, 200);
    // The token claimed ECR (2). The server used the employee's real branch.
    assert.deepEqual(seen.report.store_ids, [MOOLAKULAM]);
  });

  it("refuses a branch manager who asks for another branch, rather than quietly narrowing", async () => {
    employeeStore.value = MOOLAKULAM;
    const res = await call(`${ROWS}&store_ids=${ECR}`, tokenFor({ designationId: STORE_MANAGER }));
    assertRefused(res, "manager naming another branch");
  });

  it("lets a branch manager re-state their own branch", async () => {
    employeeStore.value = MOOLAKULAM;
    const res = await call(
      `${ROWS}&store_ids=${MOOLAKULAM}`,
      tokenFor({ designationId: STORE_MANAGER })
    );
    assert.equal(res.body.code, 200);
    assert.deepEqual(seen.report.store_ids, [MOOLAKULAM]);
  });

  it("applies the SAME scope to the export as to the screen", async () => {
    employeeStore.value = ECR;
    const res = await call(EXPORT, tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(res.status, 200);
    assert.deepEqual(seen.report.store_ids, [ECR]);
    employeeStore.value = MOOLAKULAM;
  });

  it("gives a company-wide caller no location restriction, and a browser filter can only narrow", async () => {
    await call(ROWS, tokenFor({ designationId: HR_ALL_STORES }));
    assert.equal(seen.report.store_ids, null);

    await call(`${ROWS}&store_ids=${ECR}`, tokenFor({ designationId: HR_ALL_STORES }));
    assert.deepEqual(seen.report.store_ids, [ECR]);
  });
});

describe("the filters are validated on the server, and the export takes the same ones", () => {
  it("refuses a request with no date range", async () => {
    const res = await call(
      "/attendance/reports/shift-change-eligibility",
      tokenFor({ designationId: HR_ALL_STORES })
    );
    assert.notEqual(res.body.code, 200);
  });

  it("refuses an unknown filter rather than ignoring it", async () => {
    const res = await call(`${ROWS}&department_id=3`, tokenFor({ designationId: HR_ALL_STORES }));
    assert.notEqual(res.body.code, 200);
  });

  it("refuses a filter value outside the vocabulary", async () => {
    const res = await call(`${ROWS}&request_status=MAYBE`, tokenFor({ designationId: HR_ALL_STORES }));
    assert.notEqual(res.body.code, 200);
  });

  it("passes the designation, employee and view filters through", async () => {
    await call(
      `${ROWS}&designation_id=5&employee_id=42&can_raise=YES&worked_longer=YES&request_status=NOT_RAISED&search=raj`,
      tokenFor({ designationId: HR_ALL_STORES })
    );
    assert.deepEqual(
      [
        seen.report.designation_id,
        seen.report.employee_id,
        seen.report.can_raise,
        seen.report.worked_longer,
        seen.report.request_status,
        seen.report.search,
      ],
      [5, 42, "YES", "YES", "NOT_RAISED", "raj"]
    );
  });

  /**
   * THE EXPORT IS NOT A SECOND QUERY.
   *
   * Both routes are called with the SAME query string by a caller holding
   * both keys, and what the usecase was asked is compared field for field. A
   * spreadsheet that quietly dropped a filter - or quietly widened a scope -
   * fails here.
   */
  it("asks the usecase for exactly what the screen asked, filters and scope alike", async () => {
    const token = tokenFor({ designationId: HR_EXPORTER });
    const query = `${RANGE}&designation_id=5&employee_id=42&can_raise=YES&worked_longer=NO&request_status=PENDING&search=raj&store_ids=${ECR}`;

    await call(`/attendance/reports/shift-change-eligibility?${query}`, token);
    const onScreen = seen.report;

    await call(`/attendance/reports/shift-change-eligibility/export.xlsx?${query}`, token);
    const inFile = seen.report;

    assert.deepEqual(inFile, onScreen);
  });

  it("the export's columns and the row builder agree, so no column is silently blank", () => {
    const routeModule = require("./attendance_shift_change_report");
    const row = routeModule.exportRow({
      attendance_date: "2026-09-18",
      employee_id: 42,
      employee_name: "Employee 42",
      outlet_name: "Moolakulam",
      designation_name: "Cashier",
      assigned_shift_name: "Evening",
      assigned_shift_in_time: "18:00:00",
      assigned_shift_out_time: "22:00:00",
      first_punch: "10:00",
      last_punch: "22:00",
      worked_hours: "12:00",
      extra_hours: "8:00",
      can_raise: true,
      worked_longer: false,
      eligibility_reason: "A longer shift is available for this date",
      request_status: "Not Raised",
      request_id: null,
    });
    assert.deepEqual(
      routeModule.EXPORT_COLUMNS.map((c) => c.key).sort(),
      Object.keys(row).sort(),
      "every declared column must be produced, and nothing else"
    );
    // Yes/No rather than true/false - a spreadsheet is read by a person.
    assert.equal(row.can_raise, "Yes");
    assert.equal(row.worked_longer, "No");
    assert.equal(row.assigned_shift, "Evening 18:00-22:00");
  });
});
