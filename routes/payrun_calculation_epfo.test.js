/**
 * EPFO 2026 wage ceiling - the HTTP surface of the two read-only endpoints the
 * "PF ceiling 2026 / ECR" modal calls, with the REAL auth, permission and
 * employee-branch-scope middleware.
 *
 *   node --test routes/payrun_calculation_epfo.test.js
 *
 *   GET /payrun/calculation/pf-ceiling-impact   the affected-employee report
 *                                                (JSON; the browser builds the CSV)
 *   GET /payrun/calculation/ecr                  the ECR, approved payroll only
 *
 * Both carry full UANs, so both need view_employee_sensitive on top of the
 * payroll keys. What the ECR files and refuses is proved in
 * `usecase/payrun_calculation.test.js`; this file proves the door.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-epfo-"));
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

const PAYROLL_HR = { designation: 61, employee: 901 }; // every key the modal needs
const NO_SENSITIVE = { designation: 62, employee: 902 }; // payroll + salary, no sensitive
const NOBODY = { designation: 63, employee: 903 };

const GRANTS = {
  [PAYROLL_HR.designation]: [
    P.VIEW_EMPLOYEES,
    P.VIEW_PAYROLL,
    P.VIEW_SALARY,
    P.VIEW_EMPLOYEE_SENSITIVE,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  [NO_SENSITIVE.designation]: [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [NOBODY.designation]: [],
};

const EMPLOYEES = [
  { employee_id: PAYROLL_HR.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: NO_SENSITIVE.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: NOBODY.employee, store_id: MOOLAKULAM, status: 1 },
];

const REPORT = {
  employees: [{ employee_id: 11, employee_name: "Test, Member", flags: ["CONTRIBUTION_INCREASES"] }],
  summary: { employees: 1, by_category: {} },
};
const NO_APPROVED_ECR = {
  period: { year: 2026, month: 9 },
  lines: [],
  text: "",
  members: [],
  errors: [{ employee_id: 11, employee_name: "Test", code: "NOT_APPROVED", message: "x" }],
  totals: { members: 0 },
  validation: [],
};

/** The usecase, as a spy: what it was handed is what the route decided. */
let seen = [];
const usecase = {
  getPfCeilingImpact: async (args) => {
    seen.push({ call: "impact", ...args });
    return REPORT;
  },
  getEcr: async (args) => {
    seen.push({ call: "ecr", ...args });
    return NO_APPROVED_ECR;
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
let current = PAYROLL_HR;

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
      store_id: MOOLAKULAM,
    },
    "1d"
  );

const get = async (who, url) => {
  current = who || PAYROLL_HR;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    headers: who ? { "x-access-token": await tokenFor(who) } : {},
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    disposition: res.headers.get("content-disposition"),
    body: await res.json().catch(() => ({})),
  };
};

const assertRefused = (res, what) => {
  assert.ok(
    res.body && (res.body.code === 401 || res.body.code === 403),
    `${what}: expected 401/403, got ${res.status} ${JSON.stringify(res.body)}`
  );
  assert.equal(seen.length, 0, `${what}: the usecase must not be reached`);
};

describe("the affected-employee report the CSV is built from", () => {
  it("answers JSON with code 200 - never a file the browser must parse as one", async () => {
    const res = await get(PAYROLL_HR, "/payrun/calculation/pf-ceiling-impact");
    assert.equal(res.status, 200);
    assert.match(res.contentType, /^application\/json/);
    assert.equal(res.disposition, null, "no attachment header: the browser names and builds the CSV");
    assert.equal(res.body.code, 200);
    assert.deepEqual(res.body.employees, REPORT.employees);
    assert.equal(seen[0].call, "impact");
  });

  it("refuses a caller without view_employee_sensitive - the report carries UANs", async () => {
    assertRefused(await get(NO_SENSITIVE, "/payrun/calculation/pf-ceiling-impact"), "no sensitive");
  });

  it("refuses a caller with no grants and a signed-out caller", async () => {
    assertRefused(await get(NOBODY, "/payrun/calculation/pf-ceiling-impact"), "no grants");
    assertRefused(await get(null, "/payrun/calculation/pf-ceiling-impact"), "signed out");
  });
});

describe("the ECR endpoint", () => {
  it("passes the month through and answers code 200 even when nothing is approved - the refusals ride in `errors`", async () => {
    const res = await get(PAYROLL_HR, "/payrun/calculation/ecr?year=2026&month=9");
    assert.equal(res.status, 200);
    assert.match(res.contentType, /^application\/json/);
    assert.equal(res.body.code, 200);
    assert.equal(res.body.lines.length, 0);
    assert.equal(res.body.errors[0].code, "NOT_APPROVED");
    assert.equal(seen[0].call, "ecr");
    assert.equal(seen[0].year, 2026);
    assert.equal(seen[0].month, 9);
  });

  it("has no unapproved preview: an include_unapproved flag is refused, not ignored", async () => {
    const res = await get(PAYROLL_HR, "/payrun/calculation/ecr?year=2026&month=9&include_unapproved=1");
    assert.notEqual(res.body.code, 200);
    assert.equal(seen.length, 0);
  });

  it("refuses a caller without view_employee_sensitive - the ECR carries full UANs", async () => {
    assertRefused(await get(NO_SENSITIVE, "/payrun/calculation/ecr?year=2026&month=9"), "no sensitive");
  });
});
