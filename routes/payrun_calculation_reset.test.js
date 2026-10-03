/**
 * Reset Calculation - the HTTP surface, with the REAL auth, permission and
 * employee-branch-scope middleware.
 *
 *   node --test routes/payrun_calculation_reset.test.js
 *
 * What a reset may discard and what it must keep is proved in
 * `usecase/payrun_calculation.test.js` and, against real SQL, in
 * `repository/payrun_calculation_reset.mysql.test.js`. This file proves the
 * door: who may reach the usecase at all, what a body may carry, and that the
 * branch scope handed to the usecase is the server's, never the caller's.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-reset-"));
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

const CLERK = { designation: 41, employee: 801 };          // calculates, one branch
const HR = { designation: 42, employee: 802 };             // calculates, every branch
const APPROVER = { designation: 43, employee: 803 };       // approves, cannot calculate
const VIEWER = { designation: 44, employee: 804 };         // reads payroll only
const NO_VIEW = { designation: 45, employee: 805 };        // process_payroll alone
const NOBODY = { designation: 46, employee: 806 };

const GRANTS = {
  [CLERK.designation]: [P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL],
  [HR.designation]: [P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [APPROVER.designation]: [P.VIEW_EMPLOYEES, P.APPROVE_PAYRUN, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [VIEWER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY],
  [NO_VIEW.designation]: [P.PROCESS_PAYROLL],
  [NOBODY.designation]: [],
};

const EMPLOYEES = [
  { employee_id: CLERK.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: HR.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: APPROVER.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: VIEWER.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: NO_VIEW.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: NOBODY.employee, store_id: MOOLAKULAM, status: 1 },
];

/** The usecase, as a spy: what it was handed is what the route decided. */
let seen = [];
const usecase = {
  reset: async (args) => {
    seen.push(args);
    return { reset_count: args.employee_ids.length, results: [] };
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
let current = CLERK;

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
      // A branch the actor is NOT in: the resolver must ignore the token's claim.
      store_id: ECR,
    },
    "1d"
  );

const post = async (who, body) => {
  current = who || CLERK;
  const res = await fetch(`http://127.0.0.1:${port}/payrun/calculation/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(who ? { "x-access-token": await tokenFor(who) } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const BODY = {
  year: 2026,
  month: 8,
  employee_ids: [11],
  reason: "ATTENDANCE_CORRECTED",
  mode: "INDIVIDUAL",
};

const assertRefused = (res, what) => {
  assert.ok(
    res.body && (res.body.code === 401 || res.body.code === 403),
    `${what}: expected 401/403, got ${res.status} ${JSON.stringify(res.body)}`
  );
  assert.equal(seen.length, 0, `${what}: the usecase must not be reached`);
};

describe("unauthorized users cannot reset", () => {
  it("refuses a signed-out caller", async () => {
    assertRefused(await post(null, BODY), "signed out");
  });

  it("refuses a caller with no grants", async () => {
    assertRefused(await post(NOBODY, BODY), "no grants");
  });

  it("refuses a payroll VIEWER - reading the month grants no reset", async () => {
    assertRefused(await post(VIEWER, BODY), "viewer");
  });

  it("refuses an APPROVER without process_payroll - approving is not resetting", async () => {
    assertRefused(await post(APPROVER, BODY), "approver only");
  });

  it("refuses process_payroll without view_employees - the keys are ANDed", async () => {
    assertRefused(await post(NO_VIEW, BODY), "process_payroll alone");
  });

  it("lets a calculator through, with the actor taken from the session", async () => {
    const res = await post(CLERK, BODY);
    assert.equal(res.body.code, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].actor.employeeId, CLERK.employee);
  });
});

describe("the employee/outlet scope is the server's", () => {
  it("a branch-scoped caller is limited to their own branch, whatever the token claims", async () => {
    await post(CLERK, BODY);
    assert.deepEqual(seen[0].store_ids, [MOOLAKULAM]);
  });

  it("an all-branches caller is company-wide", async () => {
    await post(HR, BODY);
    assert.equal(seen[0].store_ids, null);
  });

  it("a body cannot widen the scope or name the actor", async () => {
    for (const extra of [
      { store_ids: [ECR] },
      { reset_by: 1 },
      { all_eligible: true },
      { status: "NOT_CALCULATED" },
      { payrun_calculation_id: 5 },
    ]) {
      const res = await post(HR, { ...BODY, ...extra });
      assert.equal(res.status, 400, `accepted ${JSON.stringify(extra)}`);
    }
    assert.equal(seen.length, 0);
  });
});

describe("the body is validated before the usecase is reached", () => {
  it("the reset reason is mandatory and must be one of the five", async () => {
    const { reason, ...noReason } = BODY;
    for (const body of [noReason, { ...BODY, reason: "" }, { ...BODY, reason: "TYPO" }]) {
      const res = await post(HR, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    for (const r of [
      "ATTENDANCE_CORRECTED",
      "SALARY_MASTER_CORRECTED",
      "WRONG_OT",
      "WRONG_ADDITION_DEDUCTION",
    ]) {
      assert.equal((await post(HR, { ...BODY, reason: r })).body.code, 200, r);
    }
    assert.equal(seen.length, 4);
  });

  it("the month, the employees and the mode are all required", async () => {
    const drop = (key) => {
      const copy = { ...BODY };
      delete copy[key];
      return copy;
    };
    for (const body of [
      drop("year"),
      drop("month"),
      drop("employee_ids"),
      drop("mode"),
      { ...BODY, month: 13 },
      { ...BODY, employee_ids: [] },
      { ...BODY, employee_ids: [-1] },
      { ...BODY, mode: "EVERYONE" },
      { ...BODY, remark: "x".repeat(501) },
    ]) {
      assert.equal((await post(HR, body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(seen.length, 0);
  });

  it("passes the reason, remark and mode through unchanged", async () => {
    await post(HR, {
      ...BODY,
      employee_ids: [11, 12],
      mode: "BULK",
      reason: "OTHER",
      remark: "DOJ corrected",
    });
    assert.equal(seen[0].reason, "OTHER");
    assert.equal(seen[0].remark, "DOJ corrected");
    assert.equal(seen[0].mode, "BULK");
    assert.deepEqual(seen[0].employee_ids, [11, 12]);
    assert.equal(seen[0].year, 2026);
    assert.equal(seen[0].month, 8);
  });
});
