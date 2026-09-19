/**
 * ONBOARDING / PENDING HR — THE BRANCH SCOPE ON BOTH OF ITS ENDPOINTS.
 *
 *   node --test routes/hr_onboarding_branch_scope.test.js
 *
 * ACCESS IS RIGHTS BASED; DATA IS STORE BASED. The dashboard at
 * `/hr/onboarding` is opened on a right - `view_hr_onboarding_dashboard`
 * beside `view_employees` - and NOT on a designation, a user type or HR
 * membership. Which employees it then shows is the EXISTING employee branch
 * scope, and nothing else. This file defends the second half, on the server,
 * for BOTH requests that screen makes:
 *
 *   GET /employee/employees             the population
 *   GET /hr/employees/status-summary    the onboarding state of that
 *                                       population
 *
 * WHY BOTH, AND WHY HERE. A frontend filter is not a security boundary, and
 * neither is one of two endpoints. If the summary were scoped less tightly
 * than the list, a branch-scoped caller could ask it for another store and
 * learn that store's employee ids AND whose records are unfinished - a leak
 * the screen would never have to render to have caused. The two are scoped by
 * the same middleware here and that is asserted, not assumed.
 *
 * THE SCOPE IS THE REAL ONE. `test_support/employee_branch_scope` builds
 * `middlewares/employee_branch_scope.js` over an in-memory employee table, so
 * these tests fail if the rule breaks. `routes/employee_master.test.js` hands
 * its router an all-branches scope on purpose - its subject is the lifecycle
 * API - which is precisely why the branch-scoped case needs a file of its
 * own.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-onboarding-scope-"));
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

const buildPermissions = require("../middlewares/permissions");
const buildSensitive = require("../middlewares/sensitive");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const { buildScopeFor } = require("../test_support/employee_branch_scope");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

/* ------------------------------------------------------------- the cast */

const KATHIRKAMAM = 2;
const MOOLAKULAM = 5;

/**
 * STORE MANAGER is the case the dashboard used to refuse outright. They hold
 * the dashboard right and the list right and NOT the all-branches key, which
 * is exactly how an administrator would grant this on the rights screen.
 */
const STORE_MANAGER = { designation: 21, employee: 901, store: KATHIRKAMAM };
/** The same store manager WITHOUT the dashboard right - refused the screen. */
const PLAIN_MANAGER = { designation: 22, employee: 902, store: KATHIRKAMAM };
/** HR: the dashboard right plus company-wide employee scope. */
const HR = { designation: 23, employee: 903, store: MOOLAKULAM };
/** HR without the sensitive key - the dashboard, minus how people are paid. */
const HR_NO_SENSITIVE = { designation: 24, employee: 904, store: MOOLAKULAM };
/** An administrator: `user_type = 2`, no keys at all, every branch. */
const ADMIN = { designation: 25, employee: 905, store: KATHIRKAMAM };

const GRANTS = {
  [STORE_MANAGER.designation]: [P.VIEW_EMPLOYEES, P.VIEW_HR_ONBOARDING_DASHBOARD],
  [PLAIN_MANAGER.designation]: [P.VIEW_EMPLOYEES],
  [HR.designation]: [
    P.VIEW_EMPLOYEES,
    P.VIEW_HR_ONBOARDING_DASHBOARD,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
    P.VIEW_EMPLOYEE_SENSITIVE,
  ],
  [HR_NO_SENSITIVE.designation]: [
    P.VIEW_EMPLOYEES,
    P.VIEW_HR_ONBOARDING_DASHBOARD,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  [ADMIN.designation]: [],
};

/** The employee table the branch resolver reads. Every actor is active. */
const EMPLOYEES = [
  { employee_id: STORE_MANAGER.employee, store_id: KATHIRKAMAM, status: 1 },
  { employee_id: PLAIN_MANAGER.employee, store_id: KATHIRKAMAM, status: 1 },
  { employee_id: HR.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: HR_NO_SENSITIVE.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: ADMIN.employee, store_id: KATHIRKAMAM, status: 1 },
];

/* ---------------------------------------------------------- the doubles */

/** What the summary usecase was asked for. The rule is in the ASK. */
const summaryCalls = [];
const statusSummaryUsecase = {
  list: async (filters, options) => {
    summaryCalls.push({ filters, options });
    return [{ employee_id: 1, aadhaar_status: "VERIFIED", bank_status: "VERIFIED", bank_payroll_ready: true }];
  },
};

/** What the employee list was asked for, and WITH WHICH ACTOR. */
const listCalls = [];
const employeeUsecase = {
  get: async (query, actor) => {
    listCalls.push({ query, actor });
    return { code: 200, list: [] };
  },
};

let server, port;

before(async () => {
  const authMiddleware = require("../middlewares/auth");
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const sensitive = buildSensitive(permissions);
  // THE REAL MIDDLEWARE over the fixture employee table - not a stub scope.
  const branchScope = buildScopeFor(permissions, EMPLOYEES);

  const app = express();
  app.use(bodyParser.json());
  app.use(
    authMiddleware.create({
      userUsecase: {
        getSessionState: async (userId) => ({
          user_id: userId,
          employee_id: userId,
          status: 1,
          token_valid_from: null,
          must_change_password: 0,
          is_system_account: 0,
          employee_status: 1,
        }),
      },
    })
  );

  delete require.cache[require.resolve("./employee_master")];
  delete require.cache[require.resolve("./employee")];
  const master = require("./employee_master")(
    {}, permissions, sensitive, null, null, statusSummaryUsecase, null, branchScope
  );
  const employees = require("./employee")(employeeUsecase, permissions, sensitive, branchScope);
  app.use("/hr", master.getRouter());
  app.use("/employee", employees.getRouter());

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

/** A session for one of the actors above. `employee_id` IS the user id here. */
const tokenFor = (who, { userType = 1 } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(who.employee),
      id: who.employee,
      employee_id: who.employee,
      user_type: userType,
      designation_id: who.designation,
      store_id: who.store,
    },
    "1d"
  );

const call = async (p, who, opts) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: { "x-access-token": await tokenFor(who, opts) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = text;
  }
  return { status: res.status, body, text };
};

const lastSummary = () => summaryCalls[summaryCalls.length - 1];
const lastList = () => listCalls[listCalls.length - 1];

/* ================= a store manager, narrowed to their own store ========= */

describe("a store manager holding the dashboard right", () => {
  it("IS SERVED BOTH ENDPOINTS - the screen is not HR-only", () => {
    // The access rule is the right, and this designation holds it. Nothing
    // about being a store manager refuses them here, which is the whole
    // change: the refusal used to be the bug.
    assert.ok(GRANTS[STORE_MANAGER.designation].includes(P.VIEW_HR_ONBOARDING_DASHBOARD));
    assert.ok(!GRANTS[STORE_MANAGER.designation].includes(P.EMPLOYEE_SCOPE_ALL_BRANCHES));
  });

  it("gets a status summary NARROWED TO THEIR OWN STORE, unasked", () => {
    return call("/hr/employees/status-summary", STORE_MANAGER).then((r) => {
      assert.equal(r.status, 200);
      // The caller named no branch. The scope supplies one anyway - and it is
      // a LIST, never `null`, because `null` means "no restriction".
      assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);
    });
  });

  it("gets an employee list carrying the SAME scope into the query", async () => {
    const r = await call("/employee/employees", STORE_MANAGER);
    assert.equal(r.status, 200);
    const scope = lastList().actor.branch_scope;
    assert.equal(scope.kind, EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES);
    assert.deepEqual(scope.store_ids, [KATHIRKAMAM]);
  });

  it("CANNOT OBTAIN ANOTHER STORE THROUGH THE STATUS SUMMARY", async () => {
    const before = summaryCalls.length;
    const r = await call(`/hr/employees/status-summary?store_ids[]=${MOOLAKULAM}`, STORE_MANAGER);
    // Refused outright rather than quietly narrowed: a request that NAMES
    // another branch is told no, so it can never be handed its own store's
    // rows under another store's heading.
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "OUT_OF_BRANCH");
    assert.equal(summaryCalls.length, before, "the usecase was never reached");
  });

  it("cannot obtain another store through the employee list either", async () => {
    const before = listCalls.length;
    const r = await call(`/employee/employees?store_ids[]=${MOOLAKULAM}`, STORE_MANAGER);
    assert.equal(r.status, 403);
    assert.equal(listCalls.length, before, "the usecase was never reached");
  });

  it("asking for their OWN store is honoured - narrowing is not widening", async () => {
    const r = await call(`/hr/employees/status-summary?store_ids[]=${KATHIRKAMAM}`, STORE_MANAGER);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);
  });

  it("is told nothing sensitive - the payment route stays its own right", async () => {
    const r = await call("/hr/employees/status-summary", STORE_MANAGER);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().options, {
      disclosePfEsiApplicability: false,
      disclosePaymentRoute: false,
    });
  });
});

/* ================= the same manager, without the right ================== */

describe("a store manager WITHOUT the dashboard right", () => {
  it("is refused the screen by the client rule, on the right alone", () => {
    // The screen's access rule is a right and the backend's list right is a
    // different one, so this designation still reads employees - as Employee
    // Master - and still does not open the queue.
    assert.ok(!GRANTS[PLAIN_MANAGER.designation].includes(P.VIEW_HR_ONBOARDING_DASHBOARD));
    assert.ok(GRANTS[PLAIN_MANAGER.designation].includes(P.VIEW_EMPLOYEES));
  });

  it("STILL GETS NO MORE DATA THAN THEIR OWN STORE from either endpoint", async () => {
    // Belt to that brace: whatever the client decides to draw, the server's
    // narrowing does not depend on the dashboard right at all.
    const summary = await call("/hr/employees/status-summary", PLAIN_MANAGER);
    assert.equal(summary.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);

    const list = await call("/employee/employees", PLAIN_MANAGER);
    assert.equal(list.status, 200);
    assert.deepEqual(lastList().actor.branch_scope.store_ids, [KATHIRKAMAM]);
  });
});

/* ================= all-branch scope, and the administrator ============== */

describe("a caller holding employee_scope_all_branches", () => {
  it("reaches every branch on both endpoints", async () => {
    const summary = await call("/hr/employees/status-summary", HR);
    assert.equal(summary.status, 200);
    // `null` - no restriction - and NOT `[]`, which would be no branch.
    assert.equal(lastSummary().filters.store_ids, undefined);

    const list = await call("/employee/employees", HR);
    assert.equal(list.status, 200);
    assert.equal(lastList().actor.branch_scope.kind, EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES);
  });

  it("may still narrow to one branch by asking", async () => {
    const r = await call(`/hr/employees/status-summary?store_ids[]=${KATHIRKAMAM}`, HR);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);
  });
});

describe("an administrator", () => {
  it("reaches every branch through the user_type bypass, holding no key", async () => {
    assert.deepEqual(GRANTS[ADMIN.designation], []);

    const summary = await call("/hr/employees/status-summary", ADMIN, { userType: 2 });
    assert.equal(summary.status, 200);
    assert.equal(lastSummary().filters.store_ids, undefined);

    const list = await call("/employee/employees", ADMIN, { userType: 2 });
    assert.equal(list.status, 200);
    assert.equal(lastList().actor.branch_scope.kind, EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES);
  });

  it("is not restricted by their own employee record's branch", async () => {
    const r = await call(`/hr/employees/status-summary?store_ids[]=${MOOLAKULAM}`, ADMIN, {
      userType: 2,
    });
    // An administrator whose employee row sits in Kathirkamam may still ask
    // about Moolakulam - the bypass is by user type, not by branch.
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [MOOLAKULAM]);
  });
});

/* ================= sensitive disclosure stays independent =============== */

describe("the sensitive payment data is a separate right from the screen", () => {
  it("is disclosed to a holder of view_employee_sensitive", async () => {
    const r = await call("/hr/employees/status-summary", HR);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().options, {
      disclosePfEsiApplicability: true,
      disclosePaymentRoute: true,
    });
  });

  it("is WITHHELD from a dashboard holder who lacks it, company-wide reach and all", async () => {
    // The clean statement of independence: same screen, same company-wide
    // employee scope, no sensitive key - so the Cash -> Bank data is not
    // disclosed. Opening the queue and being told how somebody is paid are
    // two rights and collapsing them would widen the second silently.
    const r = await call("/hr/employees/status-summary", HR_NO_SENSITIVE);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().options, {
      disclosePfEsiApplicability: false,
      disclosePaymentRoute: false,
    });
    assert.equal(lastSummary().filters.store_ids, undefined, "their reach is unaffected");
  });
});
