/**
 * Payroll Dashboard - the HTTP surface, with the REAL auth, permission and
 * employee-branch-scope middleware and the REAL dashboard usecase over two
 * branch-aware fake payrun stages.
 *
 *   node --test routes/payroll_dashboard.test.js
 *
 * What it proves: the three payroll keys are required; a branch-scoped caller
 * sees only their branch - in the KPIs, the filter choices, the month strip
 * and every drill-down - and is refused a location outside it; a
 * company-wide caller sees every branch and can narrow to one.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-payroll-dashboard-"));
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

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const auth = require("../middlewares/auth");
const buildPermissions = require("../middlewares/permissions");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const { buildScopeFor } = require("../test_support/employee_branch_scope");
const buildDashboard = require("../usecase/payroll_dashboard");

const USER_ID = 7;
const MOOLAKULAM = 1;
const ECR = 2;

const BRANCH_VIEWER = { designation: 61, employee: 901 }; // payroll keys, own branch (Moolakulam)
const HQ_VIEWER = { designation: 62, employee: 902 }; // payroll keys + all branches
const NO_SALARY = { designation: 63, employee: 903 }; // view_payroll without view_salary
const READ_ONLY = { designation: 64, employee: 904 }; // only view_employees
const NO_PAYROLL = { designation: 65, employee: 905 }; // view_employees + view_salary
const NO_EMPLOYEES = { designation: 66, employee: 906 }; // view_payroll + view_salary, no view_employees
const TWO_BRANCH = { designation: 67, employee: 907 }; // payroll keys, Moolakulam AND ECR
const LAWSPET = 3;

const GRANTS = {
  [BRANCH_VIEWER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY],
  [HQ_VIEWER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [NO_SALARY.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL],
  [READ_ONLY.designation]: [P.VIEW_EMPLOYEES],
  [NO_PAYROLL.designation]: [P.VIEW_EMPLOYEES, P.VIEW_SALARY],
  [NO_EMPLOYEES.designation]: [P.VIEW_PAYROLL, P.VIEW_SALARY],
  [TWO_BRANCH.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY],
};

const EMPLOYEES = [BRANCH_VIEWER, HQ_VIEWER, NO_SALARY, READ_ONLY, NO_PAYROLL, NO_EMPLOYEES].map((who) => ({
  employee_id: who.employee,
  store_id: MOOLAKULAM,
  status: 1,
})).concat([{ employee_id: TWO_BRANCH.employee, store_ids: [MOOLAKULAM, ECR], status: 1 }]);

/* --------------------------------------------- the month, in two branches */

const money = (gross, net) => ({ gross, deductions: String(gross - net), net: String(net), pf: "0", esi: "0", advance: "0", shortage: "0", missing_hours: "0" });
const CALC = [
  { employee_id: 1, employee_name: "Anitha", store_id: MOOLAKULAM, location: "Moolakulam", department_id: 10, department_name: "Billing", designation_id: 100, designation_name: "Cashier", status: "READY_FOR_APPROVAL", status_label: "Ready for approval", blockers: [], recalculation_reasons: [], figures: money(20000, 19000) },
  { employee_id: 2, employee_name: "Bala", store_id: ECR, location: "ECR", department_id: 11, department_name: "Stores", designation_id: 101, designation_name: "Loader", status: "READY_FOR_APPROVAL", status_label: "Ready for approval", blockers: [], recalculation_reasons: [], figures: money(50000, 45000) },
];
const INIT = [
  { employee_id: 3, employee_name: "Chitra", store_id: MOOLAKULAM, store_name: "Moolakulam", designation_id: 100, designation_name: "Cashier", status: "BLOCKED", initialized: false, blocking_reasons: [{ code: "SALARY_NOT_APPROVED", label: "Salary not approved" }] },
  { employee_id: 4, employee_name: "Deepak", store_id: ECR, store_name: "ECR", designation_id: 101, designation_name: "Loader", status: "READY", initialized: false, blocking_reasons: [] },
];

const inScope = (store_ids) => (r) => store_ids === null || store_ids.includes(r.store_id);
let seen = [];
const payrun = {
  getMonth: async ({ year, month, store_ids }) => {
    seen.push({ name: "payrun.getMonth", year, month, store_ids });
    return { month_locked: false, rows: month === 8 ? INIT.filter(inScope(store_ids)) : [] };
  },
};
const calculation = {
  getMonthFigures: async ({ year, month, store_ids }) => {
    seen.push({ name: "calculation.getMonthFigures", year, month, store_ids });
    return { month_locked: false, rows: month === 8 ? CALC.filter(inScope(store_ids)) : [] };
  },
};
const repo = {
  listEmployeeFacts: async (ids) => ids.map((id) => ({ employee_id: id, department_id: id === 3 ? 10 : 11, department_name: id === 3 ? "Billing" : "Stores", employment_type: "Permanent" })),
  listPeriodsInWindow: async () => [],
  listMonthTotals: async (args) => {
    seen.push({ name: "repo.listMonthTotals", ...args });
    return [];
  },
};

const sessionFor = (who) => ({
  user_id: USER_ID,
  employee_id: who.employee,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
});

let server;
let port;
let current = BRANCH_VIEWER;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionFor(current) } }));
  const branchScope = buildScopeFor(permissions, EMPLOYEES);
  const usecase = buildDashboard(repo, payrun, calculation, { today: () => "2026-10-06" });
  const sensitive = require("../middlewares/sensitive")(permissions);
  const routes = require("./payroll_dashboard")(usecase, permissions, sensitive, branchScope);
  app.use("/", routes.getRouter());
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());
beforeEach(() => {
  seen = [];
});

const tokenFor = (who) =>
  jwtService.sign(
    { auth_ver: 2, sub: String(USER_ID), id: USER_ID, employee_id: who.employee, user_type: 1, designation_id: who.designation, store_id: ECR },
    "1d"
  );

const get = async (who, route, query) => {
  current = who;
  const res = await fetch(`http://127.0.0.1:${port}/payroll/dashboard/${route}?${new URLSearchParams(query)}`, {
    headers: { "x-access-token": await tokenFor(who) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})), cache: res.headers.get("cache-control") };
};
const MONTH = { year: 2026, month: 8 };
const ids = (rows) => rows.map((r) => r.employee_id).sort();

describe("permissions", () => {
  it("needs view_employees + view_payroll + view_salary", async () => {
    for (const who of [NO_SALARY, READ_ONLY, NO_PAYROLL, NO_EMPLOYEES]) {
      for (const route of ["summary", "months", "employees"]) {
        const res = await get(who, route, { ...MONTH, fy: 2026, metric: "ALL" });
        assert.equal(res.status, 403, `${route} for ${who.designation}`);
      }
    }
    assert.equal(seen.length, 0, "nothing was read for a refused caller");
  });

  it("is never cached", async () => {
    assert.equal((await get(BRANCH_VIEWER, "summary", MONTH)).cache, "no-store");
  });
});

describe("branch scope", () => {
  it("a branch-scoped caller's whole dashboard is their branch", async () => {
    const res = await get(BRANCH_VIEWER, "summary", MONTH);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(seen.filter((s) => s.month === 8).map((s) => s.store_ids), [[MOOLAKULAM], [MOOLAKULAM]]);
    assert.equal(res.body.kpis.total_employees, 2);
    assert.equal(res.body.kpis.payroll_cost, "20000.00");
    assert.deepEqual(res.body.filters.options.locations.map((l) => l.id), [MOOLAKULAM]);
    assert.ok(!JSON.stringify(res.body).includes("Bala"), "no ECR employee anywhere in the response");
    assert.ok(!JSON.stringify(res.body).includes("Deepak"));
  });

  it("no drill-down leaks another branch's employee", async () => {
    for (const metric of ["ALL", "COSTED", "NOT_INITIALIZED", "ACTION_NOT_INITIALIZED"]) {
      const res = await get(BRANCH_VIEWER, "employees", { ...MONTH, metric });
      assert.equal(res.status, 200);
      res.body.rows.forEach((r) => assert.ok([1, 3].includes(r.employee_id), `${metric} leaked ${r.employee_id}`));
    }
    const pending = await get(BRANCH_VIEWER, "employees", { ...MONTH, metric: "ACTION_NOT_INITIALIZED" });
    assert.deepEqual(ids(pending.body.rows), [3], "Chitra only - Deepak is not initialized too, but at ECR");
  });

  it("a location outside the caller's branches is refused, on every route", async () => {
    const queries = { summary: MONTH, months: { fy: 2026 }, employees: { ...MONTH, metric: "ALL" } };
    for (const [route, query] of Object.entries(queries)) {
      const res = await get(BRANCH_VIEWER, route, { ...query, store_id: ECR });
      assert.equal(res.status, 403, route);
    }
    assert.equal(seen.length, 0);
  });

  it("the month strip is scoped too", async () => {
    const res = await get(BRANCH_VIEWER, "months", { fy: 2026 });
    assert.equal(res.status, 200);
    assert.deepEqual(seen[0].store_ids, [MOOLAKULAM]);
    assert.equal(res.body.months.length, 12);
    assert.equal(res.body.label, "FY 2026-27");
  });

  it("a company-wide caller sees every branch and can narrow to one", async () => {
    const all = await get(HQ_VIEWER, "summary", MONTH);
    assert.equal(all.body.kpis.total_employees, 4);
    assert.equal(all.body.kpis.payroll_cost, "70000.00");
    assert.deepEqual(all.body.filters.options.locations.map((l) => l.id).sort(), [MOOLAKULAM, ECR]);

    const ecr = await get(HQ_VIEWER, "summary", { ...MONTH, store_id: ECR });
    assert.equal(ecr.body.kpis.total_employees, 2);
    assert.equal(ecr.body.kpis.net_payable, "45000.00");
    assert.equal(ecr.body.filters.options.locations.length, 2, "the location choices stay the whole scope");
    assert.deepEqual(ecr.body.filters.options.departments.map((d) => d.id), [11]);

    const strip = await get(HQ_VIEWER, "months", { fy: 2026, store_id: ECR });
    assert.deepEqual(seen.find((s) => s.name === "repo.listMonthTotals" && s.store_ids && s.store_ids[0] === ECR).store_ids, [ECR]);
    assert.equal(strip.status, 200);
  });
});

describe("filters and drill-downs at the door", () => {
  it("department and designation narrow every panel", async () => {
    const res = await get(HQ_VIEWER, "summary", { ...MONTH, department_id: 11, designation_id: 101 });
    assert.equal(res.body.kpis.total_employees, 2);
    assert.equal(res.body.headcount.location.length, 1);
    const drill = await get(HQ_VIEWER, "employees", { ...MONTH, department_id: 11, metric: "ALL" });
    assert.deepEqual(ids(drill.body.rows), [2, 4]);
  });

  it("Not Initialized shows the exact employees pending", async () => {
    const res = await get(BRANCH_VIEWER, "employees", { ...MONTH, metric: "NOT_INITIALIZED" });
    assert.deepEqual(ids(res.body.rows), [3]);
    assert.equal(res.body.rows[0].stage, "INITIALIZATION");
  });

  it("head-count bars drill to the employees behind them", async () => {
    const res = await get(HQ_VIEWER, "employees", { ...MONTH, metric: "HEADCOUNT", group_by: "location", group_id: String(ECR) });
    assert.deepEqual(ids(res.body.rows), [2, 4]);
  });

  it("compares with the previous month by default, or a chosen one", async () => {
    const res = await get(HQ_VIEWER, "summary", MONTH);
    assert.deepEqual([res.body.comparison.compare.year, res.body.comparison.compare.month], [2026, 7]);
    const chosen = await get(HQ_VIEWER, "summary", { ...MONTH, compare_year: 2026, compare_month: 4 });
    assert.equal(chosen.body.comparison.compare.label, "April 2026");
    const gross = chosen.body.comparison.metrics.find((m) => m.key === "GROSS");
    assert.deepEqual([gross.base, gross.compare, gross.difference], ["70000.00", "0.00", "70000.00"]);
  });

  it("an empty, not-started month answers with zeros and no figures", async () => {
    const res = await get(HQ_VIEWER, "summary", { year: 2027, month: 2 });
    assert.equal(res.status, 200);
    assert.equal(res.body.kpis.total_employees, 0);
    assert.equal(res.body.kpis.payroll_cost, "0.00");
    res.body.actions.forEach((a) => assert.equal(a.count, 0));
  });

  it("refuses bad input", async () => {
    for (const bad of [
      { ...MONTH, metric: "SALARY_OF_EVERYONE" },
      { ...MONTH, metric: "HEADCOUNT", group_by: "salary" },
      { ...MONTH, metric: "ALL", store_id: "1 OR 1=1" },
      { year: 2026, month: 13, metric: "ALL" },
    ]) {
      const res = await get(HQ_VIEWER, "employees", bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });
});

describe("review: scope edge cases through the real middleware", () => {
  it("a multi-branch user sees exactly their branches, and may narrow to either", async () => {
    const all = await get(TWO_BRANCH, "summary", MONTH);
    assert.equal(all.status, 200);
    assert.deepEqual(seen.filter((s) => s.name === "payrun.getMonth" && s.month === 8)[0].store_ids.sort(), [MOOLAKULAM, ECR]);
    assert.equal(all.body.kpis.total_employees, 4);
    const ecr = await get(TWO_BRANCH, "summary", { ...MONTH, store_id: ECR });
    assert.equal(ecr.body.kpis.total_employees, 2);
    const lawspet = await get(TWO_BRANCH, "summary", { ...MONTH, store_id: LAWSPET });
    assert.equal(lawspet.status, 403, "a third branch is refused");
  });

  it("a malformed location never broadens the scope - it is refused before anything is read", async () => {
    seen = [];
    for (const bad of ["abc", "0", "-1", "1.5", "1,2", "1 OR 1=1", "%27"]) {
      const res = await get(BRANCH_VIEWER, "summary", { ...MONTH, store_id: bad });
      assert.equal(res.status, 400, `store_id=${bad}`);
    }
    current = BRANCH_VIEWER;
    const res = await fetch(`http://127.0.0.1:${port}/payroll/dashboard/summary?year=2026&month=8&store_id=1&store_id=2`, {
      headers: { "x-access-token": await tokenFor(BRANCH_VIEWER) },
    });
    assert.equal(res.status, 400, "a repeated store_id (array) is refused");
    assert.equal(seen.length, 0);
  });

  it("no location filter is the caller's whole scope, never company-wide for a branch user", async () => {
    await get(BRANCH_VIEWER, "employees", { ...MONTH, metric: "ALL" });
    seen.filter((s) => s.store_ids !== undefined).forEach((s) => assert.deepEqual(s.store_ids, [MOOLAKULAM]));
  });
});

describe("review: B3 sensitive fields", () => {
  const { SENSITIVE_EMPLOYEE_FIELDS } = require("../constants/sensitive_fields");
  const keysOf = (value, out = new Set()) => {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => { out.add(k.toLowerCase()); keysOf(v, out); });
    return out;
  };

  it("no response carries a field from the sensitive vocabulary", async () => {
    const bodies = [
      (await get(HQ_VIEWER, "summary", MONTH)).body,
      (await get(HQ_VIEWER, "months", { fy: 2026 })).body,
      ...(await Promise.all(["ALL", "COSTED", "DED_PF", "DED_ESI", "NOT_INITIALIZED"].map((metric) => get(HQ_VIEWER, "employees", { ...MONTH, metric })))).map((r) => r.body),
    ];
    const keys = keysOf(bodies);
    SENSITIVE_EMPLOYEE_FIELDS.forEach((f) => assert.ok(!keys.has(f.toLowerCase()), `response carries sensitive key ${f}`));
  });

  it("PF / ESI amounts survive the B3 filter for a caller without view_employee_sensitive", async () => {
    const res = await get(HQ_VIEWER, "employees", { ...MONTH, metric: "COSTED" });
    assert.equal(res.status, 200);
    res.body.rows.forEach((r) => {
      assert.ok("employee_pf" in r && "employee_esi" in r);
      assert.notEqual(r.gross, null, "pay figures are not stripped");
    });
  });

  it("the router refuses to be built without the filter", () => {
    assert.throws(() => require("./payroll_dashboard")({}, { requireAll: () => (q, s, n) => n() }, null, {}), /sensitive-field filter is required/);
  });
});
