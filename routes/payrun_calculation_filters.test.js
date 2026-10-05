/**
 * Calculation & Review - the Department / Designation filters at the HTTP
 * surface, with the REAL auth, permission and employee-branch-scope
 * middleware.
 *
 *   node --test routes/payrun_calculation_filters.test.js
 *
 * What the filters select is proved in `usecase/payrun_calculation.test.js`.
 * This file proves the door: the month read takes them, a select-all carries
 * them (and a location) to the usecase, explicit ids never do, a location
 * outside the caller's branches is refused, and no permission changed.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-calc-filters-"));
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

const USER_ID = 7;
const MOOLAKULAM = 1;
const ECR = 2;

const VIEWER = { designation: 61, employee: 901 };          // reads payroll, one branch
const CLERK = { designation: 62, employee: 902 };           // calculates, one branch
const APPROVER = { designation: 63, employee: 903 };        // approves, one branch
const HQ_APPROVER = { designation: 64, employee: 904 };     // approves, every branch
const PUBLISHER = { designation: 65, employee: 905 };       // publishes, one branch
const EXPORTER = { designation: 66, employee: 906 };        // payroll viewer + payroll_export_payslips, one branch
const EXPORT_ONLY = { designation: 67, employee: 907 };     // payroll_export_payslips without the view keys

const GRANTS = {
  [VIEWER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY],
  [CLERK.designation]: [P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL],
  [APPROVER.designation]: [P.VIEW_EMPLOYEES, P.APPROVE_PAYRUN],
  [HQ_APPROVER.designation]: [P.VIEW_EMPLOYEES, P.APPROVE_PAYRUN, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [PUBLISHER.designation]: [P.VIEW_EMPLOYEES, P.PUBLISH_PAYRUN],
  [EXPORTER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY, P.PAYROLL_EXPORT_PAYSLIPS],
  [EXPORT_ONLY.designation]: [P.VIEW_EMPLOYEES, P.PAYROLL_EXPORT_PAYSLIPS],
};

const EMPLOYEES = [VIEWER, CLERK, APPROVER, HQ_APPROVER, PUBLISHER, EXPORTER, EXPORT_ONLY].map((who) => ({
  employee_id: who.employee,
  store_id: MOOLAKULAM,
  status: 1,
}));

/** The usecase, as a spy: what it was handed is what the route decided. */
let seen = [];
const spy = (name) => async (args) => {
  seen.push({ name, ...args });
  return { rows: [], summary: {}, results: [] };
};
const usecase = {
  getMonth: spy("getMonth"),
  calculate: spy("calculate"),
  approve: spy("approve"),
  publishAllApproved: spy("publishAllApproved"),
  exportPayslipPdfs: async (args) => {
    seen.push({ name: "exportPayslipPdfs", ...args });
    return { period_year: args.year, period_month: args.month, files: [], skipped: [] };
  },
  getPayslip: async (args) => {
    seen.push({ name: "getPayslip", ...args });
    return { employee_id: args.employee_id, payslip: null, versions: [] };
  },
  planPayslipExport: async (args) => {
    seen.push({ name: "planPayslipExport", ...args });
    return { employee_ids: [], count: 0, batch_size: 25 };
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
let current = VIEWER;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionFor(current) } }));
  const branchScope = buildScopeFor(permissions, EMPLOYEES);
  const routes = require("./payrun_calculation")(usecase, permissions, null, branchScope);
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
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: who.employee,
      user_type: 1,
      designation_id: who.designation,
      store_id: ECR,
    },
    "1d"
  );

const call = async (who, method, url, body) => {
  current = who;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json", "x-access-token": await tokenFor(who) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const get = (who, query) => call(who, "GET", `/payrun/calculation/month?${new URLSearchParams(query)}`);
const get2 = (who, path, query) => call(who, "GET", `${path}?${new URLSearchParams(query)}`);
const post = (who, url, body) => call(who, "POST", `/payrun/calculation/${url}`, body);
const MONTH = { year: 2026, month: 9 };

describe("the month read takes Department and Designation", () => {
  it("passes them to the usecase with the server's branch scope", async () => {
    const res = await get(VIEWER, { ...MONTH, department_id: 10, designation_id: 100, card: "READY_FOR_APPROVAL", search: "ani" });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(
      [seen[0].department_id, seen[0].designation_id, seen[0].card, seen[0].search, seen[0].store_ids],
      ["10", "100", "READY_FOR_APPROVAL", "ani", [MOOLAKULAM]]
    );
  });

  it("an empty choice is All", async () => {
    assert.equal((await get(VIEWER, { ...MONTH, department_id: "", designation_id: "" })).status, 200);
  });

  it("refuses a department or designation that is not an id", async () => {
    for (const bad of [{ department_id: "sales" }, { designation_id: "-1" }, { department_id: "1 OR 1=1" }]) {
      const res = await get(VIEWER, { ...MONTH, ...bad });
      assert.notEqual(res.status, 200, JSON.stringify(bad));
    }
    assert.equal(seen.length, 0);
  });

  it("the outlet scope stays enforced: a location outside the caller's branches is refused", async () => {
    const res = await get(VIEWER, { ...MONTH, store_ids: ECR, department_id: 10 });
    assert.notEqual(res.status, 200);
    assert.equal(seen.length, 0);
  });
});

describe("a select-all carries the list's filters; explicit ids never do", () => {
  const FILTERS = { store_ids: MOOLAKULAM, department_id: 10, designation_id: 100, card: "READY_FOR_APPROVAL", search: "ani" };

  it("Approve All Ready hands the usecase the filters and the requested location", async () => {
    const res = await post(HQ_APPROVER, "approve", { ...MONTH, all_ready: true, mode: "BULK", ...FILTERS });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(seen[0].filters, { department_id: 10, designation_id: 100, card: "READY_FOR_APPROVAL", search: "ani" });
    assert.deepEqual(seen[0].store_ids, [MOOLAKULAM]);
    assert.equal(seen[0].all_ready, true);
  });

  it("Approve All Ready without filters is the month in the caller's scope, as before", async () => {
    await post(HQ_APPROVER, "approve", { ...MONTH, all_ready: true });
    assert.equal(seen[0].filters && Object.keys(seen[0].filters).length, 0);
    assert.equal(seen[0].store_ids, null, "an all-branches approver is company-wide");
  });

  it("explicit ids ignore the filters and any requested location", async () => {
    await post(HQ_APPROVER, "approve", { ...MONTH, employee_ids: [11], ...FILTERS });
    assert.equal(seen[0].filters, null);
    assert.equal(seen[0].store_ids, null);
  });

  it("a branch-scoped approver cannot widen a select-all to another branch", async () => {
    const res = await post(APPROVER, "approve", { ...MONTH, all_ready: true, store_ids: ECR });
    assert.notEqual(res.status, 200);
    assert.equal(seen.length, 0);
  });

  it("Calculate All Eligible carries the filters, inside the clerk's branch", async () => {
    await post(CLERK, "calculate", { ...MONTH, all_eligible: true, department_id: 20 });
    assert.deepEqual(seen[0].filters, { department_id: 20 });
    assert.deepEqual(seen[0].store_ids, [MOOLAKULAM]);
  });

  it("Publish All carries the filters", async () => {
    await post(PUBLISHER, "publish-all", { ...MONTH, designation_id: 200 });
    assert.deepEqual(seen[0].filters, { designation_id: 200 });
    assert.deepEqual(seen[0].store_ids, [MOOLAKULAM]);
  });

  it("permissions are unchanged: filters grant nothing", async () => {
    assert.notEqual((await post(VIEWER, "approve", { ...MONTH, all_ready: true, department_id: 10 })).status, 200);
    assert.notEqual((await post(APPROVER, "calculate", { ...MONTH, all_eligible: true, department_id: 10 })).status, 200);
    assert.equal(seen.length, 0);
  });

  it("a body still cannot carry a figure or an actor", async () => {
    for (const extra of [{ net_pay: 1 }, { approved_by: 1 }, { status_label: "x" }]) {
      const res = await post(HQ_APPROVER, "approve", { ...MONTH, all_ready: true, department_id: 10, ...extra });
      assert.notEqual(res.status, 200, JSON.stringify(extra));
    }
    assert.equal(seen.length, 0);
  });
});

describe("bulk payslip export: payroll_export_payslips on top of the View Payslip keys", () => {
  const FILTERS = { store_ids: MOOLAKULAM, department_id: 10, designation_id: 100, card: "PUBLISHED", search: "ani" };

  it("1. a payroll viewer WITHOUT payroll_export_payslips can view one payslip but cannot bulk export", async () => {
    const one = await get2(VIEWER, "/payrun/calculation/payslip", { ...MONTH, employee_id: 11 });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(seen.filter((x) => x.name === "getPayslip").length, 1);
    seen = [];
    assert.equal((await post(VIEWER, "payslips/export/plan", { ...MONTH })).body.code, 403);
    assert.equal((await post(VIEWER, "payslips/export", { ...MONTH, employee_ids: [11] })).body.code, 403);
    assert.equal(seen.length, 0, "the usecase is not reached");
  });

  it("2. with payroll_export_payslips and the view keys: plan and batch run, inside the caller's branch", async () => {
    const plan = await post(EXPORTER, "payslips/export/plan", { ...MONTH, ...FILTERS });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.deepEqual(seen[0].filters, { department_id: 10, designation_id: 100, card: "PUBLISHED", search: "ani" });
    assert.deepEqual(seen[0].store_ids, [MOOLAKULAM]);
    const batch = await post(EXPORTER, "payslips/export", { ...MONTH, ...FILTERS, employee_ids: [11, 12] });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.deepEqual([seen[1].employee_ids, seen[1].store_ids], [[11, 12], [MOOLAKULAM]]);
  });

  it("2b. with no location chosen, the export is still confined to the caller's own branch", async () => {
    await post(EXPORTER, "payslips/export/plan", { ...MONTH });
    assert.deepEqual(seen[0].store_ids, [MOOLAKULAM]);
  });

  it("3. crafting another branch into the request is refused, for the plan and the batch", async () => {
    assert.notEqual((await post(EXPORTER, "payslips/export/plan", { ...MONTH, store_ids: ECR })).status, 200);
    assert.notEqual((await post(EXPORTER, "payslips/export", { ...MONTH, store_ids: ECR, employee_ids: [11] })).status, 200);
    assert.notEqual((await post(EXPORTER, "payslips/export", { ...MONTH, store_ids: `${MOOLAKULAM},${ECR}`, employee_ids: [11] })).status, 200);
    assert.equal(seen.length, 0);
  });

  it("the export key alone - without the payroll view keys - grants nothing", async () => {
    assert.notEqual((await post(EXPORT_ONLY, "payslips/export/plan", { ...MONTH })).status, 200);
    assert.notEqual((await post(EXPORT_ONLY, "payslips/export", { ...MONTH, employee_ids: [11] })).status, 200);
    assert.equal(seen.length, 0);
  });

  it("refuses the other payroll roles", async () => {
    for (const who of [CLERK, APPROVER, PUBLISHER]) {
      assert.notEqual((await post(who, "payslips/export", { ...MONTH, employee_ids: [11] })).status, 200);
      assert.notEqual((await post(who, "payslips/export/plan", { ...MONTH })).status, 200);
    }
    assert.equal(seen.length, 0);
  });

  it("refuses more than 25 per batch, no ids, or an unknown key", async () => {
    for (const bad of [
      { ...MONTH, employee_ids: Array.from({ length: 26 }, (_, i) => i + 1) },
      { ...MONTH, employee_ids: [] },
      { ...MONTH },
      { ...MONTH, employee_ids: [11], record_view: true },
    ]) {
      assert.notEqual((await post(EXPORTER, "payslips/export", bad)).status, 200, JSON.stringify(bad));
    }
    assert.equal(seen.length, 0);
  });
});
