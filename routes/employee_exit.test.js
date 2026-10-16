/**
 * F&F SETTLEMENT, EXIT INTERVIEW AND REHIRE at the HTTP surface, with the
 * REAL auth, permission and employee-branch-scope middleware.
 *
 *   node --test routes/employee_exit.test.js
 *
 * The door: who may read the F&F list (net pay), who may change F&F money,
 * who may read the CONFIDENTIAL interview / rehire assessment, and that the
 * branch scope and the request schema are enforced before the usecase runs.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-exit-routes-"));
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

const PAYROLL_VIEWER = { designation: 71, employee: 911 }; // payroll reads, no F&F key
const FNF_VIEWER = { designation: 72, employee: 912 };     // F&F list, ECR only
const FNF_MANAGER = { designation: 73, employee: 913 };    // F&F writes, ECR only
const HR_VIEWER = { designation: 74, employee: 914 };      // confidential reads, all branches
const HR_MANAGER = { designation: 75, employee: 915 };     // interview + first rehire, all branches
const HR_OVERRIDER = { designation: 76, employee: 916 };   // rehire override only, all branches
const OUTLET_HR = { designation: 77, employee: 917 };      // confidential reads, ECR only

const GRANTS = {
  [PAYROLL_VIEWER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY],
  [FNF_VIEWER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_SALARY, P.VIEW_FNF_SETTLEMENT],
  [FNF_MANAGER.designation]: [P.VIEW_EMPLOYEES, P.MANAGE_FNF_SETTLEMENT],
  [HR_VIEWER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [HR_MANAGER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW, P.MANAGE_EXIT_INTERVIEW, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [HR_OVERRIDER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW, P.OVERRIDE_REHIRE_ELIGIBILITY, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [OUTLET_HR.designation]: [P.VIEW_EMPLOYEES, P.VIEW_EXIT_INTERVIEW],
};
const CALLERS = [PAYROLL_VIEWER, FNF_VIEWER, FNF_MANAGER, HR_VIEWER, HR_MANAGER, HR_OVERRIDER, OUTLET_HR];
const EMPLOYEES = [
  ...CALLERS.map((who) => ({ employee_id: who.employee, store_id: ECR, status: 1 })),
  { employee_id: 2095, store_id: ECR, status: 0 },
  { employee_id: 3001, store_id: MOOLAKULAM, status: 0 },
];

let seen = [];
const spy = (name, out = {}) => async (...args) => {
  seen.push({ name, args });
  return typeof out === "function" ? out(...args) : { code: 200, ...out };
};
const usecase = {
  getMonth: spy("getMonth", { rows: [] }),
  getItems: spy("getItems", { items: [] }),
  saveItems: spy("saveItems"),
  settle: spy("settle"),
  reopen: spy("reopen"),
  employeeExits: spy("employeeExits", { exits: [] }),
  exitDetail: spy("exitDetail", { interview: null }),
  rehireStatus: spy("rehireStatus", { rehire: null }),
  saveInterview: spy("saveInterview"),
  assessRehire: spy("assessRehire"),
};

const sessionFor = (who) => ({
  user_id: USER_ID, employee_id: who.employee, status: 1, token_valid_from: null,
  must_change_password: 0, is_system_account: 0, employee_status: 1,
});

let server;
let port;
let current = PAYROLL_VIEWER;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionFor(current) } }));
  const routes = require("./employee_exit")(usecase, permissions, buildScopeFor(permissions, EMPLOYEES));
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
const call = async (who, method, url, body) => {
  current = who;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json", "x-access-token": await tokenFor(who) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const MONTH = { year: 2026, month: 8 };
const ITEMS = { ...MONTH, employee_id: 2095, items: [{ component: "GRATUITY", amount: 1000 }] };
const SETTLE = { ...MONTH, employee_id: 2095, payment_mode: "BANK", payment_reference: "UTR1", paid_on: "2026-09-10" };
const INTERVIEW = { exit_date: "2026-08-16", interview_date: "2026-08-16", primary_reason: "RELOCATION" };

describe("F&F payroll endpoints", () => {
  it("a payroll viewer WITHOUT view_fnf_settlement cannot read the F&F list", async () => {
    assert.equal((await call(PAYROLL_VIEWER, "GET", `/payrun/fnf/month?${new URLSearchParams(MONTH)}`)).status, 403);
    assert.equal(seen.length, 0);
  });

  it("an F&F viewer reads it, inside their own branch only", async () => {
    const res = await call(FNF_VIEWER, "GET", `/payrun/fnf/month?${new URLSearchParams(MONTH)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(seen[0].args[0].store_ids, [ECR]);
  });

  it("reading is not writing: an F&F viewer cannot change F&F money or settle", async () => {
    assert.equal((await call(FNF_VIEWER, "POST", "/payrun/fnf/items", ITEMS)).status, 403);
    assert.equal((await call(FNF_VIEWER, "POST", "/payrun/fnf/settle", SETTLE)).status, 403);
    assert.equal((await call(FNF_VIEWER, "POST", "/payrun/fnf/reopen", { ...MONTH, employee_id: 2095, reason: "x" })).status, 403);
    assert.equal(seen.length, 0);
  });

  it("an F&F manager writes, with the server's actor and branch scope", async () => {
    assert.equal((await call(FNF_MANAGER, "POST", "/payrun/fnf/items", ITEMS)).status, 200);
    assert.equal(seen[0].args[0].actor.employeeId, FNF_MANAGER.employee);
    assert.deepEqual(seen[0].args[0].store_ids, [ECR]);
    assert.equal((await call(FNF_MANAGER, "POST", "/payrun/fnf/settle", SETTLE)).status, 200);
  });

  it("the schema refuses figures and fields a client may not send", async () => {
    for (const body of [
      { ...ITEMS, net_pay: 999 },
      { ...ITEMS, items: [{ component: "OTHER", amount: 1 }] },
      { ...ITEMS, items: [{ component: "GRATUITY", amount: -1 }] },
      { ...SETTLE, settled_net_amount: 1 },
      { ...SETTLE, payment_mode: "UPI" },
      { ...SETTLE, paid_on: "10/09/2026" },
    ]) {
      const url = body.items ? "/payrun/fnf/items" : "/payrun/fnf/settle";
      assert.notEqual((await call(FNF_MANAGER, "POST", url, body)).status, 200, JSON.stringify(body));
    }
    assert.equal(seen.length, 0);
  });
});

describe("CONFIDENTIAL exit interview and rehire", () => {
  it("unauthorized HR access: payroll and F&F roles cannot read interviews or rehire assessments", async () => {
    for (const who of [PAYROLL_VIEWER, FNF_VIEWER, FNF_MANAGER]) {
      assert.equal((await call(who, "GET", "/hr/exit/employee/2095")).status, 403);
      assert.equal((await call(who, "GET", "/hr/exit/employee/2095/case/1")).status, 403);
      assert.equal((await call(who, "GET", "/hr/exit/employee/2095/rehire-status")).status, 403);
    }
    assert.equal(seen.length, 0);
  });

  it("a confidential reader reads, but cannot record an interview or a rehire assessment", async () => {
    assert.equal((await call(HR_VIEWER, "GET", "/hr/exit/employee/2095")).status, 200);
    assert.equal((await call(HR_VIEWER, "POST", "/hr/exit/employee/2095/interview", INTERVIEW)).status, 403);
    assert.equal((await call(HR_VIEWER, "POST", "/hr/exit/employee/2095/rehire", { exit_date: "2026-08-16", eligibility: "YES" })).status, 403);
  });

  it("a branch-scoped HR reader cannot reach an employee of another branch", async () => {
    assert.equal((await call(OUTLET_HR, "GET", "/hr/exit/employee/2095")).status, 200);
    seen = [];
    assert.equal((await call(OUTLET_HR, "GET", "/hr/exit/employee/3001")).status, 403);
    assert.equal(seen.length, 0);
  });

  it("rehire: the manager and the overrider both get in; the usecase is told which keys they hold", async () => {
    assert.equal((await call(HR_MANAGER, "POST", "/hr/exit/employee/2095/rehire", { exit_date: "2026-08-16", eligibility: "YES" })).status, 200);
    assert.deepEqual(seen[0].args[2], { canManage: true, canOverride: false });
    seen = [];
    assert.equal(
      (await call(HR_OVERRIDER, "POST", "/hr/exit/employee/2095/rehire", { exit_date: "2026-08-16", eligibility: "NO", override_reason: "r" })).status,
      200
    );
    assert.deepEqual(seen[0].args[2], { canManage: false, canOverride: true });
  });

  it("the interview schema refuses unknown reasons, out-of-range ratings and extra fields", async () => {
    for (const body of [
      { ...INTERVIEW, primary_reason: "BORED" },
      { ...INTERVIEW, rating_compensation: 9 },
      { ...INTERVIEW, rehire_eligibility: "YES" },
    ]) {
      assert.notEqual((await call(HR_MANAGER, "POST", "/hr/exit/employee/2095/interview", body)).status, 200, JSON.stringify(body));
    }
    assert.equal(seen.length, 0);
  });
});
